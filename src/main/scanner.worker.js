'use strict';

// Runs in a worker thread. Walks a directory tree, builds a node graph, sums
// sizes bottom-up, and reports progress/done over parentPort. Never touches
// the main thread's event loop.

const { parentPort, workerData } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PROGRESS_INTERVAL_MS = 200;

// Pruning budget. The worker builds the full tree, then emits at most this many
// nodes so main/renderer never receive the full graph. A treemap can't draw
// hundreds of thousands of rects anyway.
const NODE_CAP = 5000;
// Children smaller than this fraction of their parent collapse into one
// synthetic "(smaller items)" node.
const SMALL_FRACTION = 0.001;

const rootPath = workerData.rootPath;

// Cancellation: main posts { type:'cancel' }; we flip a flag and check it each
// iteration. No hard kill — we unwind cleanly and report what we have.
let cancelled = false;
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'cancel') cancelled = true;
});

let filesSeen = 0;
let dirsSeen = 0;
let bytesSeen = 0;
let errors = 0;
let lastPost = 0;

// Only multi-linked inodes go in here (nlink > 1), so it stays small on a
// normal filesystem. Each inode's blocks are counted once.
const seenInodes = new Set();

function postProgress(currentPath, force) {
  const now = Date.now();
  if (!force && now - lastPost < PROGRESS_INTERVAL_MS) return;
  lastPost = now;
  parentPort.postMessage({
    type: 'progress',
    filesSeen,
    bytesSeen,
    errors,
    path: currentPath,
  });
}

function makeNode(name, fullPath, size, type, mtime) {
  const node = { name, path: fullPath, size, type, mtime };
  // Files are leaves — no children array (saves one allocation per file).
  if (type === 'dir') node.children = [];
  return node;
}

// Pass 1: iterative pre-order walk. Returns dir nodes in discovery order.
async function walk(rootNode, rootDev) {
  const stack = [rootNode];
  const dirs = [rootNode];

  while (stack.length > 0) {
    if (cancelled) return dirs;
    const dirNode = stack.pop();

    let dirHandle;
    try {
      dirHandle = await fsp.opendir(dirNode.path);
    } catch {
      // Can't open the directory at all (EACCES/EPERM/...). Count and skip.
      errors++;
      continue;
    }

    try {
      for await (const dirent of dirHandle) {
        if (cancelled) return dirs; // async iterator auto-closes on return

        // Skip symlinks outright; following them can loop forever.
        if (dirent.isSymbolicLink()) continue;

        const childPath = path.join(dirNode.path, dirent.name);

        let st;
        try {
          st = await fsp.lstat(childPath);
        } catch {
          errors++;
          continue;
        }

        if (st.isSymbolicLink()) continue; // backstop if dirent d_type lied

        if (st.isDirectory()) {
          const node = makeNode(dirent.name, childPath, 0, 'dir', st.mtimeMs);
          dirNode.children.push(node);
          dirsSeen++;
          // Don't cross mount points: keep the node, don't descend.
          if (st.dev === rootDev) {
            stack.push(node);
            dirs.push(node);
          }
        } else if (st.isFile()) {
          let size = st.size;
          if (st.nlink > 1) {
            const key = `${st.dev}:${st.ino}`;
            if (seenInodes.has(key)) size = 0; // inode already counted
            else seenInodes.add(key);
          }
          dirNode.children.push(makeNode(dirent.name, childPath, size, 'file', st.mtimeMs));
          filesSeen++;
          bytesSeen += size;
        }
        // Other types (sockets, fifos, devices) are ignored.

        postProgress(childPath, false);
      }
    } catch {
      // Directory stream failed partway (e.g. EIO). Count and move on.
      errors++;
    }
  }

  return dirs;
}

// Pass 2: bottom-up size aggregation, no recursion. dirs is in pre-order, so a
// parent always precedes its children — summing in reverse means every child
// is totalled before its parent is reached.
function aggregate(dirs) {
  for (let i = dirs.length - 1; i >= 0; i--) {
    const dir = dirs[i];
    let total = 0;
    for (let j = 0; j < dir.children.length; j++) total += dir.children[j].size;
    dir.size = total;
  }
}

// Minimal binary max-heap keyed on node size — drives best-first expansion so
// the pruning budget is spent on the largest subtrees first.
class MaxHeap {
  constructor() {
    this.a = [];
  }
  size() {
    return this.a.length;
  }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].key >= a[i].key) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < n && a[l].key > a[m].key) m = l;
        if (r < n && a[r].key > a[m].key) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function copyNode(n) {
  return makeNode(n.name, n.path, n.size, n.type, n.mtime);
}

// Produce a renderable subset (<= NODE_CAP nodes) from the full tree. Small
// children collapse into one synthetic "(smaller items)" node per directory so
// every directory's total still reconciles. Directories whose contents are not
// fully represented are flagged pruned:true with their real childCount, so the
// UI can show there's more inside and a zoom (re-scan) can reveal it.
function prune(realRoot) {
  const prunedRoot = copyNode(realRoot);
  let nodeCount = 1;

  const heap = new MaxHeap();
  heap.push({ key: realRoot.size, real: realRoot, pruned: prunedRoot });

  while (heap.size() > 0 && nodeCount < NODE_CAP) {
    const { real, pruned } = heap.pop();
    const realChildren = real.children;
    if (!realChildren || realChildren.length === 0) continue;

    const threshold = real.size * SMALL_FRACTION;

    // Classify children by the 0.1%-of-parent rule.
    const bigs = [];
    let smallSum = 0;
    let smallCount = 0;
    for (const c of realChildren) {
      if (c.size > 0 && c.size >= threshold) bigs.push(c);
      else {
        smallSum += c.size;
        smallCount++;
      }
    }
    bigs.sort((a, b) => b.size - a.size); // largest first; cuts fall on smallest

    // Enforce the global budget within this directory.
    const slots = NODE_CAP - nodeCount;
    let needSynthetic = smallCount > 0;
    let maxBigs = needSynthetic ? slots - 1 : slots;
    if (maxBigs < 0) maxBigs = 0;
    if (bigs.length > maxBigs) {
      needSynthetic = true;
      maxBigs = slots - 1;
      if (maxBigs < 0) maxBigs = 0;
      for (let i = maxBigs; i < bigs.length; i++) {
        smallSum += bigs[i].size;
        smallCount++;
      }
      bigs.length = maxBigs;
    }

    for (const c of bigs) {
      const pc = copyNode(c);
      pruned.children.push(pc);
      nodeCount++;
      if (c.type === 'dir' && c.children && c.children.length > 0) {
        heap.push({ key: c.size, real: c, pruned: pc });
      }
    }

    if (needSynthetic && smallCount > 0) {
      pruned.children.push({
        name: '(smaller items)',
        path: real.path,
        size: smallSum,
        type: 'file',
        mtime: real.mtime,
        synthetic: true,
        count: smallCount,
      });
      nodeCount++;
      pruned.pruned = true;
      pruned.childCount = realChildren.length;
    }
  }

  // Directories still queued when the budget ran out become pruned leaves that
  // keep their real size and child count.
  while (heap.size() > 0) {
    const { real, pruned } = heap.pop();
    if (real.children && real.children.length > 0) {
      pruned.pruned = true;
      pruned.childCount = real.children.length;
    }
  }

  return { tree: prunedRoot, nodesSent: nodeCount };
}

async function main() {
  const rootStat = await fsp.lstat(rootPath); // fatal on failure -> rejects
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${rootPath}`);

  const rootNode = makeNode(
    path.basename(rootPath) || rootPath,
    rootPath,
    0,
    'dir',
    rootStat.mtimeMs,
  );
  dirsSeen++;

  const t0 = Date.now();
  const dirs = await walk(rootNode, rootStat.dev);
  const t1 = Date.now();

  if (cancelled) {
    parentPort.postMessage({
      type: 'done',
      cancelled: true,
      tree: null,
      filesSeen,
      bytesSeen,
      errors,
      pass1Ms: t1 - t0,
      pass2Ms: 0,
    });
    return;
  }

  aggregate(dirs);
  const t2 = Date.now();

  // Prune to a renderable set BEFORE postMessage, so main/renderer never
  // receive the full tree. The worker still holds the full tree here; it dies
  // with the worker moments later.
  const { tree, nodesSent } = prune(rootNode);
  const t3 = Date.now();

  postProgress(rootPath, true);
  parentPort.postMessage({
    type: 'done',
    cancelled: false,
    tree,
    filesSeen,
    bytesSeen,
    errors,
    nodesTotal: filesSeen + dirsSeen,
    nodesSent,
    pass1Ms: t1 - t0,
    pass2Ms: t2 - t1,
    pruneMs: t3 - t2,
  });
}

main().catch((err) => {
  parentPort.postMessage({
    type: 'error',
    message: err && err.message ? err.message : String(err),
  });
});

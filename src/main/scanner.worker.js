'use strict';

// Runs in a worker thread. Walks a directory tree, builds a node graph, sums
// sizes bottom-up, and reports progress/done over parentPort. Never touches
// the main thread's event loop.

const { parentPort, workerData } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PROGRESS_INTERVAL_MS = 200;
const rootPath = workerData.rootPath;

// Cancellation: main posts { type:'cancel' }; we flip a flag and check it each
// iteration. No hard kill — we unwind cleanly and report what we have.
let cancelled = false;
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'cancel') cancelled = true;
});

let filesSeen = 0;
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

  postProgress(rootPath, true);
  parentPort.postMessage({
    type: 'done',
    cancelled: false,
    tree: rootNode,
    filesSeen,
    bytesSeen,
    errors,
    pass1Ms: t1 - t0,
    pass2Ms: t2 - t1,
  });
}

main().catch((err) => {
  parentPort.postMessage({
    type: 'error',
    message: err && err.message ? err.message : String(err),
  });
});

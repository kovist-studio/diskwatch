'use strict';

// Main-thread wrapper around scanner.worker.js. Owns the worker lifecycle,
// enforces one-scan-at-a-time, and guarantees the returned Promise settles
// exactly once.

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.join(__dirname, 'scanner.worker.js');
const TERMINATE_GRACE_MS = 2000;

let current = null; // { worker, settled, cancelRequested, terminateTimer }

function cancelledResult() {
  return {
    type: 'done',
    cancelled: true,
    tree: null,
    filesSeen: 0,
    bytesSeen: 0,
    errors: 0,
    pass1Ms: 0,
    pass2Ms: 0,
  };
}

function cleanup(state) {
  if (state.terminateTimer) {
    clearTimeout(state.terminateTimer);
    state.terminateTimer = null;
  }
  if (current === state) current = null;
}

// Ask the active scan to stop. Returns true if there was one. The worker
// unwinds cleanly on the cancel flag; if it doesn't exit within the grace
// window we terminate() it as a fallback.
function cancelScan() {
  if (!current) return false;
  const state = current;
  state.cancelRequested = true;
  try {
    state.worker.postMessage({ type: 'cancel' });
  } catch {
    // Worker may already be gone; the exit handler will settle it.
  }
  if (!state.terminateTimer) {
    state.terminateTimer = setTimeout(() => {
      try {
        state.worker.terminate();
      } catch {
        /* already gone */
      }
    }, TERMINATE_GRACE_MS);
  }
  return true;
}

function startScan(rootPath, onProgress) {
  // Only one scan at a time — starting a new one cancels the previous.
  cancelScan();

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { rootPath } });
    const state = { worker, settled: false, cancelRequested: false, terminateTimer: null };
    current = state;

    const settle = (fn, value) => {
      if (state.settled) return;
      state.settled = true;
      cleanup(state);
      fn(value);
    };

    worker.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'progress') {
        if (typeof onProgress === 'function') onProgress(msg);
      } else if (msg.type === 'done') {
        settle(resolve, msg);
      } else if (msg.type === 'error') {
        settle(reject, new Error(msg.message));
      }
    });

    worker.on('error', (err) => settle(reject, err));

    // 'exit' commonly fires right after 'done' — the settled guard makes that
    // a no-op. It only carries meaning when the worker exits unsettled.
    worker.on('exit', (code) => {
      if (state.cancelRequested || code === 0) {
        settle(resolve, cancelledResult());
      } else {
        settle(reject, new Error(`scan worker exited with code ${code}`));
      }
    });
  });
}

module.exports = { startScan, cancelScan };

'use strict';

// The block field: what the shared canvas shows while a scan is running.
//
// A grid of disk-like squares where each block stands for a fixed QUANTUM of
// files. Blocks fill as files are counted, and they stay filled.
//
// There is deliberately no percentage here. A directory walk cannot know its
// total until it has finished, so any denominator would be invented. Instead,
// when the grid would fill completely the quantum doubles and the field
// redraws at half density — so it never wraps back to empty and never implies
// a total it doesn't have. The current scale is always stated beside it
// ("1 block = 50 files"), so the field is readable as a count, not a guess.
//
// Pixel machinery lives in CanvasSurface; this class owns only what is drawn.

const DEFAULT_QUANTUM = 25;
// Safety stop for the doubling loop. Unreachable on a real filesystem — one
// block would have to stand for a trillion files.
const MAX_QUANTUM = 2 ** 40;

class BlockField extends window.CanvasSurface {
  constructor(canvas, options) {
    super(canvas);
    const opts = options || {};

    this.baseQuantum = opts.quantum > 0 ? opts.quantum : DEFAULT_QUANTUM;
    // Called with the new quantum each time the scale doubles, so the UI can
    // keep its "1 block = N files" label truthful.
    this.onScaleChange = typeof opts.onScaleChange === 'function' ? opts.onScaleChange : null;

    this.quantum = this.baseQuantum;
    this.files = 0;
    this.filled = 0;
    this.counting = false; // drives the brighter leading-edge block

    // Grid tunables (CSS px).
    this.cell = 14;
    this.gap = 5;
    this.cols = 1;
    this.rows = 1;
    this.capacity = 1;
  }

  layout() {
    const step = this.cell + this.gap;
    this.cols = Math.max(1, Math.floor((this.cssW + this.gap) / step));
    this.rows = Math.max(1, Math.floor((this.cssH + this.gap) / step));
    this.capacity = this.cols * this.rows;

    // Center the grid so leftover space is even on both sides.
    const gridW = this.cols * this.cell + (this.cols - 1) * this.gap;
    const gridH = this.rows * this.cell + (this.rows - 1) * this.gap;
    this.offX = Math.floor((this.cssW - gridW) / 2);
    this.offY = Math.floor((this.cssH - gridH) / 2);

    // A narrower window holds fewer blocks. Re-deriving the scale here keeps
    // the invariant (filled < capacity) true across a resize; because the
    // quantum only ever grows, a resize can coarsen the scale but never
    // un-fill a block by making the field claim less than it has counted.
    this._rescale();
  }

  // Derive `filled` from the file count, doubling the quantum as many times as
  // it takes to fit. The loop (rather than a single doubling) matters because
  // progress arrives in 200ms batches: a fast volume can jump far enough in
  // one message to cross several scales at once.
  _rescale() {
    // Before the first layout the grid is a placeholder 1x1; rescaling against
    // it would inflate the quantum on nothing but a missing measurement.
    if (!this.hasArea()) return;

    const cap = this.capacity;
    let changed = false;
    while (this.quantum < MAX_QUANTUM && Math.floor(this.files / this.quantum) >= cap) {
      this.quantum *= 2;
      changed = true;
    }
    this.filled = Math.min(cap, Math.floor(this.files / this.quantum));
    if (changed && this.onScaleChange) this.onScaleChange(this.quantum);
  }

  // Start a new scan: back to the base scale with an empty field.
  reset() {
    this.quantum = this.baseQuantum;
    this.files = 0;
    this.filled = 0;
    this.counting = true;
    this.render();
  }

  // The leading edge only means something while files are still arriving.
  setCounting(counting) {
    this.counting = !!counting;
    this.render();
  }

  setFiles(n) {
    const next = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    // Counts only move forward within a scan; a stale message must never walk
    // the field backwards.
    if (next < this.files) return;
    this.files = next;
    this._rescale();
    this.render();
  }

  render() {
    const ctx = this.ctx;
    if (!this.active || !ctx || !this.hasArea()) return;

    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const filled = this.filled;
    const edge = filled - 1; // frontier block gets the brighter --signal
    const step = this.cell + this.gap;

    for (let i = 0; i < this.capacity; i++) {
      const col = i % this.cols;
      const row = (i / this.cols) | 0;
      const x = this.offX + col * step;
      const y = this.offY + row * step;

      if (i < filled) {
        ctx.fillStyle = i === edge && this.counting ? this.colEdge : this.colFill;
      } else {
        ctx.fillStyle = this.colEmpty;
      }
      ctx.fillRect(x, y, this.cell, this.cell);
    }
  }
}

window.BlockField = BlockField;

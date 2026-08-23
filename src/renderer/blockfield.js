'use strict';

// Reusable canvas surface for DiskWatch.
//
// Today it renders the "block field" — a grid of disk-like squares that fill
// with brass in proportion to scan progress, with a brighter leading edge. It
// replaces a progress bar. In P6 the SAME surface (DPR handling, resize wiring,
// palette lookup, render loop) becomes the treemap; the split to keep in mind
// is: the constructor/_resize/_readPalette machinery owns pixels, render() owns
// what gets drawn. Swap render() for a treemap pass and the rest is reused.

class BlockField {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = canvas.parentElement || canvas;

    this.progress = 0;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;

    // Grid tunables (CSS px).
    this.cell = 14;
    this.gap = 5;

    this._readPalette();

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.host);
    this._resize();
  }

  // Single source of truth for colors: read them from the CSS custom
  // properties so the canvas can never drift from the stylesheet palette.
  _readPalette() {
    const s = getComputedStyle(document.documentElement);
    const get = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
    this.colEmpty = get('--surface-2', '#232B36');
    this.colFill = get('--brass', '#C9B896');
    this.colEdge = get('--signal', '#E0A458');
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(0, Math.floor(rect.width));
    this.cssH = Math.max(0, Math.floor(rect.height));
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    // Backing store in device pixels; draw in CSS pixels. Crisp on retina.
    this.canvas.width = Math.floor(this.cssW * this.dpr);
    this.canvas.height = Math.floor(this.cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this._computeGrid();
    this.render();
  }

  _computeGrid() {
    const step = this.cell + this.gap;
    this.cols = Math.max(1, Math.floor((this.cssW + this.gap) / step));
    this.rows = Math.max(1, Math.floor((this.cssH + this.gap) / step));
    this.total = this.cols * this.rows;

    // Center the grid so leftover space is even on both sides.
    const gridW = this.cols * this.cell + (this.cols - 1) * this.gap;
    const gridH = this.rows * this.cell + (this.rows - 1) * this.gap;
    this.offX = Math.floor((this.cssW - gridW) / 2);
    this.offY = Math.floor((this.cssH - gridH) / 2);
  }

  setProgress(p) {
    this.progress = Math.min(1, Math.max(0, p));
    this.render();
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || this.cssW === 0 || this.cssH === 0) return;

    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const filled = Math.round(this.progress * this.total);
    const edge = filled - 1; // frontier block gets the brighter --signal
    const step = this.cell + this.gap;

    for (let i = 0; i < this.total; i++) {
      const col = i % this.cols;
      const row = (i / this.cols) | 0;
      const x = this.offX + col * step;
      const y = this.offY + row * step;

      if (i < filled) {
        ctx.fillStyle = i === edge && this.progress < 1 ? this.colEdge : this.colFill;
      } else {
        ctx.fillStyle = this.colEmpty;
      }
      ctx.fillRect(x, y, this.cell, this.cell);
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

window.BlockField = BlockField;

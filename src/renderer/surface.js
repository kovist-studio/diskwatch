'use strict';

// Shared canvas machinery for DiskWatch's one drawing surface.
//
// The scan view has a single <canvas>. Two renderers take turns on it: the
// block field while a scan runs, the treemap once one finishes. This class
// owns the part that is identical either way — device-pixel handling, resize
// wiring, and reading colours out of the stylesheet — and leaves layout() and
// render() to the subclass.
//
// Exactly one renderer is active at a time. An inactive one ignores resizes
// and draws nothing, so two renderers sharing one canvas can never fight over
// the same pixels. Activating re-measures, because a canvas that was hidden
// while the layout changed has a stale idea of its own size.

class CanvasSurface {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = canvas.parentElement || canvas;

    this.active = false;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;

    this._readPalette();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.host);
  }

  // Single source of truth for colours: read them from the CSS custom
  // properties so the canvas can never drift from the stylesheet palette.
  // Subclasses override this, call super, and add their own.
  _readPalette() {
    const s = getComputedStyle(document.documentElement);
    const get = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
    this.css = get;
    this.colSurface = get('--surface', '#1A2029');
    this.colEmpty = get('--surface-2', '#232B36');
    this.colLine = get('--line', '#2E3846');
    this.colInk = get('--ink', '#12161F');
    this.colText = get('--text', '#E4E8EE');
    this.colDim = get('--text-dim', '#8B95A5');
    this.colFill = get('--brass', '#C9B896');
    this.colEdge = get('--signal', '#E0A458');
    this.fontUi = get('--font-ui', 'system-ui, sans-serif');
  }

  hasArea() {
    return this.cssW > 0 && this.cssH > 0;
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.resize();
  }

  deactivate() {
    this.active = false;
  }

  resize() {
    if (!this.active) return;

    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(0, Math.floor(rect.width));
    this.cssH = Math.max(0, Math.floor(rect.height));
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    // Backing store in device pixels; draw in CSS pixels. Crisp on retina.
    this.canvas.width = Math.floor(this.cssW * this.dpr);
    this.canvas.height = Math.floor(this.cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.layout();
    this.render();
  }

  // Pointer position in CSS pixels, relative to the canvas.
  pointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  clear() {
    if (this.ctx && this.hasArea()) this.ctx.clearRect(0, 0, this.cssW, this.cssH);
  }

  layout() {}

  render() {}

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

window.CanvasSurface = CanvasSurface;

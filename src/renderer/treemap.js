'use strict';

// The treemap: what the shared canvas shows once a scan finishes.
//
// Every rectangle's AREA is its size on disk, so the picture answers "what is
// using the space" by looking at it. Layout is d3-hierarchy's squarified
// treemap (see DECISIONS.md, P6, for how squarify works and why area alone
// isn't enough).
//
// Drawn to canvas rather than SVG deliberately: the pruned tree carries up to
// ~5,000 nodes, and 5,000 SVG elements is 5,000 pieces of live DOM to style,
// hit-test and reflow. Canvas is one element and a loop of fillRect calls, and
// hit-testing is a coordinate comparison we do ourselves.

const HEADER_H = 17; // label band on a top-level directory, when it fits
const MIN_LABEL_W = 54;
// Average area per child below which a 1px sibling gap costs more than it
// gives. Roughly an 11x11 rectangle.
const MIN_AREA_PER_CHILD = 120;
const MIN_LABEL_H = 17;

// File categories. Extension first, except that anything living under a cache
// directory is a cache whatever it is named — a .png inside Caches is not a
// photo the user chose to keep.
const EXTENSIONS = {
  media: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'svg', 'tiff', 'tif', 'bmp', 'ico',
          'raw', 'cr2', 'nef', 'psd', 'ai',
          'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv',
          'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'oga', 'aiff', 'aif', 'wma'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'odt', 'ods',
              'pages', 'numbers', 'key', 'epub', 'mobi', 'csv', 'tsv'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cc', 'cpp',
         'hpp', 'java', 'kt', 'swift', 'm', 'mm', 'sh', 'zsh', 'bash', 'pl', 'php', 'lua', 'r',
         'json', 'yml', 'yaml', 'toml', 'ini', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'sql'],
  caches: ['cache', 'tmp', 'temp', 'log', 'lock', 'pid', 'part', 'crdownload', 'download'],
  system: ['plist', 'db', 'sqlite', 'sqlite3', 'realm', 'dylib', 'so', 'a', 'o', 'dSYM', 'kext',
           'pkg', 'dmg', 'iso', 'app', 'framework', 'bundle', 'nib', 'car', 'icns', 'ipa', 'apk',
           'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'],
};

const BY_EXT = new Map();
Object.keys(EXTENSIONS).forEach((cat) => {
  EXTENSIONS[cat].forEach((ext) => BY_EXT.set(ext, cat));
});

const CACHE_SEGMENTS = /(^|\/)(caches?|cachestorage|tmp|temp|logs?|deriveddata|\.cache)(\/|$)/i;
const SYSTEM_SEGMENTS = /(^|\/)(system|library\/frameworks|private\/var|windows|winsxs|program files)(\/|$)/i;

function categoryOf(data) {
  if (data.synthetic) return 'other';
  const path = data.path || '';
  if (CACHE_SEGMENTS.test(path)) return 'caches';
  if (data.type === 'dir') {
    return SYSTEM_SEGMENTS.test(path) ? 'system' : 'other';
  }
  const dot = data.name.lastIndexOf('.');
  const ext = dot > 0 ? data.name.slice(dot + 1).toLowerCase() : '';
  const byExt = BY_EXT.get(ext);
  if (byExt) return byExt;
  if (SYSTEM_SEGMENTS.test(path)) return 'system';
  return 'other';
}

// A directory the worker could not fully represent: it has real children that
// are not in this tree. See DECISIONS.md, P3.
function isPruned(data) {
  return data.type === 'dir' && data.pruned === true;
}

// The tree's directories already carry an aggregated `size`, so a plain
// d3 .sum() would double-count: the parent's own size PLUS its children's.
// A directory whose children are present here contributes nothing of its own
// and takes its value from them. A directory that is a leaf here — pruned, or
// genuinely empty — contributes its real size, which is the only record of
// what is inside it.
function valueOf(data) {
  const expanded = data.type === 'dir' && Array.isArray(data.children) && data.children.length > 0;
  return expanded ? 0 : Math.max(0, data.size || 0);
}

// Files omit `children` entirely — it is `undefined`, not `[]`. Branch on the
// type, never on truthiness, so the shape of the data stays explicit.
function childrenOf(data) {
  return data.type === 'dir' ? data.children : undefined;
}

class Treemap extends window.CanvasSurface {
  constructor(canvas, options) {
    super(canvas);
    const opts = options || {};
    this.onHover = typeof opts.onHover === 'function' ? opts.onHover : null;
    this.onZoom = typeof opts.onZoom === 'function' ? opts.onZoom : null;

    this.tree = null;
    this.root = null;
    this.hovered = null;

    this._handlers = {
      mousemove: (e) => this._onMove(e),
      mouseleave: () => this._onLeave(),
      click: (e) => this._onClick(e),
    };
  }

  _readPalette() {
    super._readPalette();
    // Monochromatic: one hue, one family, separated only by lightness. The
    // map should read as a single material with denser and lighter regions,
    // not as a chart with five competing colours.
    this.cat = {
      media: this.css('--cat-media', 'hsl(40 32% 74%)'),
      documents: this.css('--cat-documents', 'hsl(40 30% 64%)'),
      code: this.css('--cat-code', 'hsl(40 28% 54%)'),
      other: this.css('--cat-other', 'hsl(40 20% 47%)'),
      caches: this.css('--cat-caches', 'hsl(40 26% 40%)'),
      system: this.css('--cat-system', 'hsl(40 22% 31%)'),
    };
    // Which fills are light enough to need dark text on top.
    this.lightCats = new Set(['media', 'documents']);
  }

  activate() {
    if (!this.active) {
      Object.keys(this._handlers).forEach((type) => {
        this.canvas.addEventListener(type, this._handlers[type]);
      });
    }
    super.activate();
  }

  deactivate() {
    if (this.active) {
      // Listeners live exactly as long as the renderer is on the canvas.
      Object.keys(this._handlers).forEach((type) => {
        this.canvas.removeEventListener(type, this._handlers[type]);
      });
    }
    this.hovered = null;
    super.deactivate();
  }

  setTree(tree) {
    this.tree = tree || null;
    this.hovered = null;
    this.layout();
    this.render();
  }

  layout() {
    if (!this.tree || !this.hasArea()) {
      this.root = null;
      return;
    }

    const root = window.d3
      .hierarchy(this.tree, childrenOf)
      .sum(valueOf)
      .sort((a, b) => b.value - a.value);

    window.d3
      .treemap()
      .tile(window.d3.treemapSquarify)
      .size([this.cssW, this.cssH])
      // A 1px gap between siblings separates them legibly — but only where
      // there is room to spend it. A flat 1px erases any child smaller than a
      // couple of pixels, which on a real disk is most of them: measured on
      // ~/Library it collapsed 1,907 of 4,760 rectangles to nothing, and on
      // ~/Downloads 2,793 of 3,492. The worker already decided what is worth
      // showing; padding must not silently prune it again. So the gap is
      // spent only when the average child can survive it.
      .paddingInner((d) => {
        const n = d.children ? d.children.length : 0;
        if (!n) return 0;
        return ((d.x1 - d.x0) * (d.y1 - d.y0)) / n > MIN_AREA_PER_CHILD ? 1 : 0;
      })
      // A label band on top-level directories, but only where there is room
      // for one. d3 positions a node before asking for its padding, so the
      // node's own height is available to decide.
      .paddingTop((d) =>
        d.depth === 1 && d.children && d.y1 - d.y0 > HEADER_H * 2.6 ? HEADER_H : 0,
      )
      .round(true)(root);

    this.root = root;
    this.nodes = root.descendants();
  }

  // The deepest laid-out node containing the point. Walking all ~5,000 nodes
  // per mousemove is a few thousand number comparisons — far cheaper than the
  // DOM hit-testing an SVG of the same size would be doing on every frame.
  hitTest(x, y) {
    if (!this.root) return null;
    let found = null;
    for (const d of this.nodes) {
      if (x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1) {
        if (!found || d.depth > found.depth) found = d;
      }
    }
    return found;
  }

  _onMove(event) {
    const { x, y } = this.pointer(event);
    const hit = this.hitTest(x, y);
    if (hit === this.hovered) return;
    this.hovered = hit;
    this.canvas.style.cursor = hit && this._zoomable(hit) ? 'pointer' : 'default';
    this.render();
    if (this.onHover) this.onHover(hit ? hit.data : null, hit ? hit.value : 0);
  }

  // The pointer leaving the canvas does NOT clear the readout. The Reveal
  // button lives outside the canvas, so clearing on exit would erase the
  // subject on the way to the verb. The highlight goes; the readout stays.
  _onLeave() {
    if (!this.hovered) return;
    this.hovered = null;
    this.canvas.style.cursor = 'default';
    this.render();
  }

  _zoomable(node) {
    return (
      node &&
      node.depth > 0 &&
      node.data.type === 'dir' &&
      !node.data.synthetic &&
      !!node.data.path
    );
  }

  _onClick(event) {
    const { x, y } = this.pointer(event);
    const hit = this.hitTest(x, y);
    if (this._zoomable(hit) && this.onZoom) this.onZoom(hit.data);
  }

  colorFor(data) {
    return this.cat[categoryOf(data)] || this.cat.other;
  }

  render() {
    const ctx = this.ctx;
    if (!this.active || !ctx || !this.hasArea()) return;

    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = this.colEmpty;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    if (!this.root) return;

    if (!this.root.children || this.root.value <= 0) {
      ctx.fillStyle = this.colDim;
      ctx.font = `13px ${this.fontUi}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Nothing in this folder takes up space.', this.cssW / 2, this.cssH / 2);
      ctx.textAlign = 'left';
      return;
    }

    for (const d of this.root.leaves()) this._drawLeaf(ctx, d);
    for (const d of this.nodes) {
      if (d.depth === 1 && d.children) this._drawContainer(ctx, d);
    }
    if (this.hovered) this._drawHighlight(ctx, this.hovered);
  }

  _drawLeaf(ctx, d) {
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    if (w <= 0 || h <= 0) return;

    const data = d.data;
    ctx.fillStyle = this.colorFor(data);
    ctx.fillRect(d.x0, d.y0, w, h);

    // An aggregate, not a thing on disk: hatched so it can never be mistaken
    // for a single file that happens to be large.
    if (data.synthetic) this._hatch(ctx, d.x0, d.y0, w, h);

    // A directory with real contents that aren't in this tree. The dashed
    // edge says the boundary is one you can cross.
    if (isPruned(data)) this._dashEdge(ctx, d.x0, d.y0, w, h);

    if (w >= MIN_LABEL_W && h >= MIN_LABEL_H) {
      const cat = categoryOf(data);
      ctx.fillStyle = this.lightCats.has(cat) ? this.colInk : this.colText;
      ctx.font = `11px ${this.fontUi}`;
      ctx.textBaseline = 'top';
      this._clippedText(ctx, this._leafLabel(data), d.x0 + 4, d.y0 + 3, w - 8);
    }
  }

  _leafLabel(data) {
    if (data.synthetic) {
      const n = data.count || 0;
      return `${n.toLocaleString()} smaller item${n === 1 ? '' : 's'}`;
    }
    return data.name;
  }

  _drawContainer(ctx, d) {
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    if (w <= 0 || h <= 0) return;

    ctx.strokeStyle = this.colLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(d.x0 + 0.5, d.y0 + 0.5, w - 1, h - 1);

    // Header band, drawn only where layout actually reserved room for it.
    const reserved = d.children[0] ? d.children[0].y0 - d.y0 : 0;
    if (reserved < HEADER_H || w < MIN_LABEL_W) return;

    ctx.fillStyle = this.colSurface;
    ctx.fillRect(d.x0, d.y0, w, HEADER_H);
    ctx.fillStyle = this.colText;
    ctx.font = `600 11px ${this.fontUi}`;
    ctx.textBaseline = 'middle';
    this._clippedText(ctx, d.data.name, d.x0 + 5, d.y0 + HEADER_H / 2 + 0.5, w - 10);
  }

  _drawHighlight(ctx, d) {
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.strokeStyle = this.colEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(d.x0 + 1, d.y0 + 1, Math.max(0, w - 2), Math.max(0, h - 2));
    ctx.restore();
  }

  // Diagonal hatch, clipped to the rect. Drawn by hand rather than as a
  // canvas pattern so it stays crisp at any device pixel ratio.
  _hatch(ctx, x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = this.colInk;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 6;
    for (let i = -h; i < w; i += step) {
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  _dashEdge(ctx, x, y, w, h) {
    if (w < 6 || h < 6) return;
    ctx.save();
    ctx.strokeStyle = this.colText;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
    ctx.restore();
  }

  _clippedText(ctx, text, x, y, maxW) {
    if (maxW <= 4) return;
    let s = text;
    if (ctx.measureText(s).width > maxW) {
      // Trim from the end and mark it, rather than letting it spill.
      while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
      s += '…';
      if (ctx.measureText(s).width > maxW) return;
    }
    ctx.fillText(s, x, y);
  }
}

Treemap.categoryOf = categoryOf;
Treemap.valueOf = valueOf;
Treemap.childrenOf = childrenOf;
window.Treemap = Treemap;

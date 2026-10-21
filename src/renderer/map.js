'use strict';

// Floor plan canvas: pan/zoom, pin placement, route waypoints, and the
// post-walk path assignment overlay.
//
// Positions are stored as normalized {u, v} in 0..1 of the plan's own extent,
// never as screen or canvas pixels. That means zooming, resizing the window, or
// swapping in a higher-resolution scan of the same floor plan leaves every
// recorded point exactly where it was.

(function () {
  const VIRTUAL_W = 1600;
  const VIRTUAL_H = 1100;
  const PIN_R = 7;
  const HIT_R = 12;

  class MapView {
    constructor(canvas, handlers = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.handlers = handlers;

      this.image = null;
      this.view = { scale: 1, tx: 0, ty: 0 };
      this.data = {
        tests: [],
        waypoints: [],
        routeIndex: 0,
        pin: { u: 0.5, v: 0.5 },
        mode: 'pin',
        threshold: 50,
        showLabels: true,
        showPath: true,
        selectedId: null,
        scaleFeetPerPx: null,
      };

      this.calibration = null; // { points: [{u,v}] } while arming
      this.assignDraft = null; // { points: [{u,v}] } while drawing a walk path

      this._drag = null;
      this._needsRedraw = false;

      this._bindEvents();
      this._observeSize();
    }

    // ---- geometry ---------------------------------------------------------

    planSize() {
      if (this.image) return { w: this.image.naturalWidth, h: this.image.naturalHeight };
      return { w: VIRTUAL_W, h: VIRTUAL_H };
    }

    toScreen(u, v) {
      const { w, h } = this.planSize();
      return {
        x: u * w * this.view.scale + this.view.tx,
        y: v * h * this.view.scale + this.view.ty,
      };
    }

    toPlan(x, y) {
      const { w, h } = this.planSize();
      return {
        u: (x - this.view.tx) / (w * this.view.scale),
        v: (y - this.view.ty) / (h * this.view.scale),
      };
    }

    fit() {
      const rect = this.canvas.getBoundingClientRect();
      const { w, h } = this.planSize();
      const pad = 24;
      const scale = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h);
      this.view.scale = scale > 0 ? scale : 1;
      this.view.tx = (rect.width - w * this.view.scale) / 2;
      this.view.ty = (rect.height - h * this.view.scale) / 2;
      this.draw();
    }

    zoomAt(x, y, factor) {
      const before = this.toPlan(x, y);
      const next = Math.max(0.05, Math.min(40, this.view.scale * factor));
      this.view.scale = next;
      const after = this.toScreen(before.u, before.v);
      this.view.tx += x - after.x;
      this.view.ty += y - after.y;
      this.draw();
    }

    // ---- data -------------------------------------------------------------

    setData(patch) {
      Object.assign(this.data, patch);
      this.draw();
    }

    setFloorplan(dataUrl) {
      return new Promise((resolve, reject) => {
        if (!dataUrl) {
          this.image = null;
          this.fit();
          resolve(null);
          return;
        }
        const img = new Image();
        img.onload = () => {
          this.image = img;
          this.fit();
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => reject(new Error('Could not decode that image'));
        img.src = dataUrl;
      });
    }

    beginCalibration() {
      this.calibration = { points: [] };
      this.draw();
    }

    cancelCalibration() {
      this.calibration = null;
      this.draw();
    }

    beginAssign() {
      this.assignDraft = { points: [] };
      this.draw();
    }

    cancelAssign() {
      this.assignDraft = null;
      this.draw();
    }

    // Distributes n points evenly along the drawn polyline by arc length, so
    // an even walking pace maps to even spacing regardless of how many
    // vertices were clicked.
    samplePath(points, n) {
      if (points.length < 2 || n < 1) return [];
      const { w, h } = this.planSize();
      // Work in plan pixels so segment lengths are not distorted by aspect.
      const px = points.map((p) => ({ x: p.u * w, y: p.v * h }));
      const segs = [];
      let total = 0;
      for (let i = 1; i < px.length; i++) {
        const len = Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y);
        segs.push({ from: px[i - 1], to: px[i], len });
        total += len;
      }
      if (total <= 0) return px.slice(0, n).map((p) => ({ u: p.x / w, v: p.y / h }));

      const out = [];
      for (let i = 0; i < n; i++) {
        // Place the first point at the path start and the last at the end.
        const t = n === 1 ? 0 : (i / (n - 1)) * total;
        let acc = 0;
        let placed = null;
        for (const s of segs) {
          if (acc + s.len >= t || s === segs[segs.length - 1]) {
            const local = s.len === 0 ? 0 : (t - acc) / s.len;
            const clamped = Math.max(0, Math.min(1, local));
            placed = {
              x: s.from.x + (s.to.x - s.from.x) * clamped,
              y: s.from.y + (s.to.y - s.from.y) * clamped,
            };
            break;
          }
          acc += s.len;
        }
        if (placed) out.push({ u: placed.x / w, v: placed.y / h });
      }
      return out;
    }

    // Offsets the pin by a real-world distance, used by auto-advance.
    stepPin(dirX, dirY, feet) {
      const { w, h } = this.planSize();
      const perPx = this.data.scaleFeetPerPx;
      // With no calibration, fall back to a fixed fraction of the plan so the
      // control still does something sensible.
      const planPx = perPx ? feet / perPx : Math.max(w, h) * 0.04;
      const u = this.data.pin.u + (dirX * planPx) / w;
      const v = this.data.pin.v + (dirY * planPx) / h;
      return {
        u: Math.max(0, Math.min(1, u)),
        v: Math.max(0, Math.min(1, v)),
      };
    }

    hitTest(x, y) {
      let best = null;
      let bestDist = HIT_R;
      for (const t of this.data.tests) {
        if (!t.position) continue;
        const s = this.toScreen(t.position.u, t.position.v);
        const d = Math.hypot(s.x - x, s.y - y);
        if (d <= bestDist) {
          bestDist = d;
          best = t;
        }
      }
      return best;
    }

    // ---- events -----------------------------------------------------------

    _bindEvents() {
      const c = this.canvas;

      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        // Trackpad pinch arrives as ctrl+wheel; treat both as zoom.
        const rect = c.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * 0.0022);
        this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      }, { passive: false });

      c.addEventListener('pointerdown', (e) => {
        c.focus();
        const rect = c.getBoundingClientRect();
        this._drag = {
          id: e.pointerId,
          startX: e.clientX - rect.left,
          startY: e.clientY - rect.top,
          lastX: e.clientX - rect.left,
          lastY: e.clientY - rect.top,
          moved: false,
          // Middle button, or space held, forces a pan even in a placing mode.
          pan: e.button === 1 || e.shiftKey,
        };
        c.setPointerCapture(e.pointerId);
      });

      c.addEventListener('pointermove', (e) => {
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (!this._drag) {
          this._hoverCursor(x, y);
          return;
        }

        const dx = x - this._drag.lastX;
        const dy = y - this._drag.lastY;
        if (Math.abs(x - this._drag.startX) > 3 || Math.abs(y - this._drag.startY) > 3) {
          this._drag.moved = true;
        }
        if (this._drag.moved) {
          this.view.tx += dx;
          this.view.ty += dy;
          this.draw();
        }
        this._drag.lastX = x;
        this._drag.lastY = y;
      });

      c.addEventListener('pointerup', (e) => {
        if (!this._drag) return;
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const wasDrag = this._drag.moved;
        this._drag = null;
        c.releasePointerCapture(e.pointerId);
        // A drag is a pan, never a placement — otherwise panning the plan would
        // scatter pins everywhere.
        if (!wasDrag) this._click(x, y, e);
      });

      c.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (this.assignDraft && this.assignDraft.points.length >= 2) {
          this.handlers.onAssignCommit?.(this.assignDraft.points.slice());
        }
      });

      c.addEventListener('keydown', (e) => {
        const nudge = e.shiftKey ? 10 : 2;
        const map = {
          ArrowLeft: [-nudge, 0], ArrowRight: [nudge, 0],
          ArrowUp: [0, -nudge], ArrowDown: [0, nudge],
        };
        if (map[e.key]) {
          e.preventDefault();
          const [dx, dy] = map[e.key];
          const { w, h } = this.planSize();
          this.handlers.onPinMove?.({
            u: Math.max(0, Math.min(1, this.data.pin.u + dx / w)),
            v: Math.max(0, Math.min(1, this.data.pin.v + dy / h)),
          });
        } else if (e.key === 'Enter' && this.assignDraft && this.assignDraft.points.length >= 2) {
          e.preventDefault();
          this.handlers.onAssignCommit?.(this.assignDraft.points.slice());
        } else if (e.key === 'Escape') {
          if (this.calibration) this.handlers.onCalibrateCancel?.();
          if (this.assignDraft) this.handlers.onAssignCancel?.();
        }
      });
    }

    _hoverCursor(x, y) {
      const over = this.hitTest(x, y);
      this.canvas.style.cursor = over ? 'pointer' : 'crosshair';
    }

    _click(x, y, evt) {
      const plan = this.toPlan(x, y);
      const clamped = {
        u: Math.max(0, Math.min(1, plan.u)),
        v: Math.max(0, Math.min(1, plan.v)),
      };

      if (this.calibration) {
        this.calibration.points.push(clamped);
        if (this.calibration.points.length === 2) {
          this.handlers.onCalibrateComplete?.(this.calibration.points.slice());
        }
        this.draw();
        return;
      }

      if (this.assignDraft) {
        this.assignDraft.points.push(clamped);
        this.handlers.onAssignProgress?.(this.assignDraft.points.length);
        this.draw();
        return;
      }

      // Clicking an existing result selects it rather than stacking a new pin
      // on top of it.
      const hit = this.hitTest(x, y);
      if (hit && !evt.altKey) {
        this.handlers.onSelect?.(hit.id);
        return;
      }

      if (this.data.mode === 'route') this.handlers.onAddWaypoint?.(clamped);
      else this.handlers.onPinMove?.(clamped);
    }

    _observeSize() {
      const ro = new ResizeObserver(() => this._resize());
      ro.observe(this.canvas.parentElement || this.canvas);
      this._resize();
    }

    _resize() {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    // ---- drawing ----------------------------------------------------------

    draw() {
      if (this._needsRedraw) return;
      this._needsRedraw = true;
      requestAnimationFrame(() => {
        this._needsRedraw = false;
        this._paint();
      });
    }

    _paint() {
      const ctx = this.ctx;
      const rect = this.canvas.getBoundingClientRect();
      const ink = window.Palette.ink();
      const surface = window.Palette.surface();

      ctx.save();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = surface;
      ctx.fillRect(0, 0, rect.width, rect.height);

      const { w, h } = this.planSize();
      const s = this.view.scale;

      if (this.image) {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.image, this.view.tx, this.view.ty, w * s, h * s);
      } else {
        this._paintGrid(ctx, ink, w, h, s);
      }

      if (this.data.showPath) this._paintWalkPath(ctx, ink);
      this._paintWaypoints(ctx, ink);
      this._paintPins(ctx, ink, surface);
      if (!this.calibration && !this.assignDraft) this._paintCursor(ctx, ink);
      this._paintCalibration(ctx, ink);
      this._paintAssignDraft(ctx, ink);

      ctx.restore();
    }

    _paintGrid(ctx, ink, w, h, s) {
      ctx.save();
      ctx.strokeStyle = ink.grid;
      ctx.lineWidth = 1;
      const step = 100 * s;
      if (step > 6) {
        ctx.beginPath();
        for (let gx = 0; gx <= w; gx += 100) {
          const x = Math.round(this.view.tx + gx * s) + 0.5;
          ctx.moveTo(x, this.view.ty);
          ctx.lineTo(x, this.view.ty + h * s);
        }
        for (let gy = 0; gy <= h; gy += 100) {
          const y = Math.round(this.view.ty + gy * s) + 0.5;
          ctx.moveTo(this.view.tx, y);
          ctx.lineTo(this.view.tx + w * s, y);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = ink.muted;
      ctx.lineWidth = 1;
      ctx.strokeRect(this.view.tx, this.view.ty, w * s, h * s);
      ctx.restore();
    }

    // The order you walked, as a thin connecting line. It is what turns a cloud
    // of dots back into a route you can recognise.
    _paintWalkPath(ctx, ink) {
      const placed = this.data.tests.filter((t) => t.position);
      if (placed.length < 2) return;
      ctx.save();
      ctx.strokeStyle = ink.muted;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      placed.forEach((t, i) => {
        const p = this.toScreen(t.position.u, t.position.v);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.restore();
    }

    _paintWaypoints(ctx, ink) {
      const wps = this.data.waypoints || [];
      if (!wps.length) return;
      ctx.save();

      ctx.strokeStyle = window.Palette.status.warning;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      wps.forEach((p, i) => {
        const s = this.toScreen(p.u, p.v);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;

      wps.forEach((p, i) => {
        const s = this.toScreen(p.u, p.v);
        const isNext = i === this.data.routeIndex;
        ctx.beginPath();
        ctx.arc(s.x, s.y, isNext ? 11 : 7, 0, Math.PI * 2);
        ctx.fillStyle = isNext ? window.Palette.status.warning : 'transparent';
        if (isNext) ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = window.Palette.status.warning;
        ctx.stroke();

        ctx.fillStyle = isNext ? '#1a1a19' : ink.secondary;
        ctx.font = '600 10px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), s.x, s.y + 0.5);
      });
      ctx.restore();
    }

    _paintPins(ctx, ink, surface) {
      const placed = this.data.tests.filter((t) => t.position);
      const labelBoxes = [];

      for (const t of placed) {
        const p = this.toScreen(t.position.u, t.position.v);
        const down = t.status === 'failed' ? 0 : (t.downloadMbps || 0);
        const flagged = t.status === 'failed' || down < this.data.threshold;
        const selected = t.id === this.data.selectedId;

        ctx.save();

        // Flagged points get a separate, redundant ring. Hue alone never
        // carries pass/fail here.
        if (flagged) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, PIN_R + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = window.Palette.status.critical;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        if (selected) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, PIN_R + 7, 0, Math.PI * 2);
          ctx.strokeStyle = ink.primary;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // 2px surface ring so overlapping pins stay countable.
        ctx.beginPath();
        ctx.arc(p.x, p.y, PIN_R, 0, Math.PI * 2);
        ctx.fillStyle = window.Palette.colorFor(down, this.data.threshold);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = surface;
        ctx.stroke();

        if (t.status === 'failed') {
          // A dead zone reads as an X, not just a dark dot.
          ctx.strokeStyle = window.Palette.status.critical;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x - 3.2, p.y - 3.2);
          ctx.lineTo(p.x + 3.2, p.y + 3.2);
          ctx.moveTo(p.x + 3.2, p.y - 3.2);
          ctx.lineTo(p.x - 3.2, p.y + 3.2);
          ctx.stroke();
        }

        ctx.restore();

        if (this.data.showLabels) {
          const text = t.status === 'failed' ? 'fail' : formatMbps(down);
          // Clear the flag ring as well as the pin, so the number never sits
          // on top of the stroke that marks it as a problem spot.
          const offset = (flagged ? PIN_R + 3.5 : PIN_R) + 5;
          this._paintLabel(ctx, ink, surface, p.x + offset, p.y, text, labelBoxes, flagged);
        }
      }
    }

    // Labels are selective by necessity: on a dense walk they would overlap
    // into mush, so a label is skipped when its box collides with one already
    // drawn. The results table carries every value regardless.
    _paintLabel(ctx, ink, surface, x, y, text, boxes, flagged) {
      ctx.save();
      ctx.font = '600 11px system-ui, -apple-system, sans-serif';
      const width = ctx.measureText(text).width;
      const box = { x: x - 2, y: y - 7, w: width + 4, h: 14 };
      const collides = boxes.some((b) => !(box.x + box.w < b.x || b.x + b.w < box.x
        || box.y + box.h < b.y || b.y + b.h < box.y));
      if (collides) {
        ctx.restore();
        return;
      }
      boxes.push(box);

      // Halo keeps the number legible over an arbitrary floor plan image.
      ctx.lineWidth = 3;
      ctx.strokeStyle = surface;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = flagged ? window.Palette.status.critical : ink.primary;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    _paintCursor(ctx, ink) {
      if (this.data.mode === 'route') return;
      const p = this.toScreen(this.data.pin.u, this.data.pin.v);
      ctx.save();
      ctx.strokeStyle = ink.primary;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 11, p.y);
      ctx.lineTo(p.x - 4, p.y);
      ctx.moveTo(p.x + 4, p.y);
      ctx.lineTo(p.x + 11, p.y);
      ctx.moveTo(p.x, p.y - 11);
      ctx.lineTo(p.x, p.y - 4);
      ctx.moveTo(p.x, p.y + 4);
      ctx.lineTo(p.x, p.y + 11);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = ink.primary;
      ctx.fill();
      ctx.restore();
    }

    _paintCalibration(ctx, ink) {
      if (!this.calibration) return;
      const pts = this.calibration.points;
      ctx.save();
      ctx.strokeStyle = window.Palette.status.warning;
      ctx.fillStyle = window.Palette.status.warning;
      ctx.lineWidth = 2;
      pts.forEach((p) => {
        const s = this.toScreen(p.u, p.v);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        ctx.fill();
      });
      if (pts.length === 2) {
        const a = this.toScreen(pts[0].u, pts[0].v);
        const b = this.toScreen(pts[1].u, pts[1].v);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    _paintAssignDraft(ctx, ink) {
      if (!this.assignDraft) return;
      const pts = this.assignDraft.points;
      if (!pts.length) return;
      ctx.save();
      ctx.strokeStyle = window.Palette.status.warning;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = this.toScreen(p.u, p.v);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();

      pts.forEach((p) => {
        const s = this.toScreen(p.u, p.v);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = window.Palette.status.warning;
        ctx.fill();
      });
      ctx.restore();
    }

    // Exports the current view at 2x for a shareable annotated map.
    toPNG() {
      const rect = this.canvas.getBoundingClientRect();
      const scaleUp = 2;
      const out = document.createElement('canvas');
      out.width = Math.round(rect.width * scaleUp);
      out.height = Math.round(rect.height * scaleUp);
      const octx = out.getContext('2d');
      octx.fillStyle = window.Palette.surface();
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(this.canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    }
  }

  function formatMbps(v) {
    const n = Number(v) || 0;
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return n.toFixed(0);
    return n.toFixed(1);
  }

  window.MapView = MapView;
  window.formatMbps = formatMbps;
})();

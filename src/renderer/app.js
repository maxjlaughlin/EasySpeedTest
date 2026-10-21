'use strict';

// UI controller: owns session state, drives the map, and turns hotkey presses
// into placed test results.

(function () {
  const api = window.api;

  const el = (id) => document.getElementById(id);

  const state = {
    info: null,
    settings: null,
    session: null,
    mode: 'pin',
    selectedId: null,
    running: false,
    // Direction and spacing of the last manual pin move. Auto-advance reuses
    // it, so clicking two points establishes the walk vector once and every
    // later hotkey press steps along it.
    lastVector: null,
    assigning: false,
  };

  let map = null;
  let saveTimer = null;

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------

  async function init() {
    state.info = await api.appInfo();
    state.settings = await api.getSettings();
    state.session = await api.getSession();

    el('version').textContent = `v${state.info.version}`;
    document.title = `EasySpeedTest v${state.info.version}`;

    buildProfileOptions();
    applySettingsToControls();
    el('session-name').value = state.session.name || 'Untitled survey';

    map = new window.MapView(el('map'), {
      onPinMove: handlePinMove,
      onAddWaypoint: handleAddWaypoint,
      onSelect: (id) => {
        state.selectedId = id;
        render();
      },
      onCalibrateComplete: handleCalibrateComplete,
      onCalibrateCancel: () => {
        map.cancelCalibration();
        el('btn-calibrate').classList.remove('is-armed');
        setHint(null);
      },
      onAssignCommit: handleAssignCommit,
      onAssignCancel: cancelAssign,
      onAssignProgress: (n) => setHint(
        `${n} point${n === 1 ? '' : 's'} — keep clicking along the path you walked, then press Enter (or double-click) to place ${unplaced().length} test${unplaced().length === 1 ? '' : 's'}.`,
      ),
    });

    if (state.session.floorplan?.file) {
      const dataUrl = await api.readFloorplan(state.session.floorplan.file);
      if (dataUrl) {
        await map.setFloorplan(dataUrl).catch(() => {});
      } else {
        toast('The floor plan image for this survey is missing.', true);
        state.session.floorplan = null;
      }
    }

    bindUI();
    bindHotkeys();
    render();
    map.fit();

    // Test seam: only present when the smoke harness is driving the app.
    if (api.smoke) {
      window.__test = {
        state, map, render, advance, unplaced, startAssign, cancelAssign,
        handleAssignCommit, describePosition, exportCsv, undoLast, reindex,
        handlePinMove, handleAddWaypoint, persist,
      };
    }
  }

  function buildProfileOptions() {
    const sel = el('sel-profile');
    sel.innerHTML = '';
    for (const p of state.info.profiles) {
      const opt = document.createElement('option');
      opt.value = p.key;
      const seconds = ((p.downloadMs + p.uploadMs) / 1000).toFixed(1).replace(/\.0$/, '');
      opt.textContent = `${p.label} · ~${seconds}s`;
      sel.appendChild(opt);
    }
    sel.value = state.settings.profile;
  }

  function applySettingsToControls() {
    el('inp-threshold').value = state.settings.thresholdMbps;
    el('inp-cap').value = state.settings.maxMbPerTest;
    el('inp-step').value = state.settings.stepFeet;
    el('opt-autoadvance').checked = state.settings.autoAdvance;
    el('opt-wifi').checked = state.settings.captureWifi;
    el('opt-awake').checked = state.settings.keepAwake;
    el('kbd-run').textContent = prettyAccelerator(state.settings.hotkeys.run);
  }

  function prettyAccelerator(acc) {
    if (!acc) return '—';
    const mac = state.info?.platform === 'darwin';
    return acc
      .replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
      .replace('Shift', mac ? '⇧' : 'Shift')
      .replace('Alt', mac ? '⌥' : 'Alt')
      .split('+')
      .join(mac ? '' : '+');
  }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.saveSession(state.session), 250);
  }

  async function patchSettings(patch) {
    state.settings = await api.setSettings(patch);
  }

  // ---------------------------------------------------------------------------
  // positioning
  // ---------------------------------------------------------------------------

  function handlePinMove(pos) {
    const prev = state.session.pin || map.data.pin;
    if (prev) {
      const dx = pos.u - prev.u;
      const dy = pos.v - prev.v;
      // Ignore micro-moves so a stray click does not redefine the walk vector.
      if (Math.hypot(dx, dy) > 0.004) state.lastVector = { du: dx, dv: dy };
    }
    state.session.pin = pos;
    persist();
    render();
  }

  function handleAddWaypoint(pos) {
    state.session.waypoints.push(pos);
    persist();
    render();
  }

  function currentPosition() {
    if (state.mode === 'assign') return null;
    if (state.mode === 'route') {
      const wps = state.session.waypoints;
      if (!wps.length) return null;
      const idx = Math.min(state.session.routeIndex, wps.length - 1);
      return { ...wps[idx], waypoint: idx + 1 };
    }
    return state.session.pin ? { ...state.session.pin } : { u: 0.5, v: 0.5 };
  }

  function advance(direction = 1) {
    if (state.mode === 'route') {
      const n = state.session.waypoints.length;
      if (!n) return;
      state.session.routeIndex = Math.max(0, Math.min(n - 1, state.session.routeIndex + direction));
      persist();
      render();
      return;
    }
    if (state.mode === 'pin') {
      const pin = state.session.pin || { u: 0.5, v: 0.5 };
      let next;
      const feet = Number(state.settings.stepFeet) || 0;
      const perPx = state.session.floorplan?.scaleFeetPerPx || null;

      if (state.lastVector) {
        const len = Math.hypot(state.lastVector.du, state.lastVector.dv) || 1;
        let du = state.lastVector.du / len;
        let dv = state.lastVector.dv / len;
        // With a calibrated plan and a step distance, walk exactly that far in
        // the established direction; otherwise repeat the last move verbatim.
        let mag = len;
        if (perPx && feet > 0) {
          const { w, h } = map.planSize();
          mag = feet / perPx / Math.max(w, h);
          du = state.lastVector.du / len;
          dv = state.lastVector.dv / len;
        }
        next = { u: pin.u + du * mag * direction, v: pin.v + dv * mag * direction };
      } else {
        next = map.stepPin(direction, 0, feet || 15);
      }
      state.session.pin = {
        u: Math.max(0, Math.min(1, next.u)),
        v: Math.max(0, Math.min(1, next.v)),
      };
      persist();
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // running tests
  // ---------------------------------------------------------------------------

  async function runTest() {
    if (state.running) {
      toast('A test is already running.');
      return;
    }
    if (state.mode === 'route' && !state.session.waypoints.length) {
      toast('Route mode needs at least one stop — click the plan to add some.', true);
      return;
    }

    state.running = true;
    const position = currentPosition();
    setPhase('Starting', true);
    el('btn-run').disabled = true;
    el('progress-fill').style.width = '0%';

    try {
      const res = await api.runTest({
        profile: state.settings.profile,
        captureWifi: state.settings.captureWifi,
        captureMeta: state.settings.captureMeta,
        maxMbPerTest: state.settings.maxMbPerTest,
        endpoints: state.settings.endpoints,
      });

      if (res.busy) {
        toast('A test is already running.');
        return;
      }

      const record = {
        ...res.result,
        id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        index: state.session.tests.length + 1,
        position,
        mode: state.mode,
      };
      state.session.tests.push(record);
      state.selectedId = record.id;
      persist();

      if (record.status === 'failed') {
        toast(`No connectivity here — recorded as a dead spot. (${record.error})`, true);
      }

      if (state.settings.autoAdvance && state.mode !== 'assign') advance(1);
      render();
      showResult(record);
    } catch (err) {
      toast(`Test failed to start: ${err.message}`, true);
    } finally {
      state.running = false;
      el('btn-run').disabled = false;
      setPhase('Ready', false);
      el('progress-fill').style.width = '0%';
    }
  }

  function undoLast() {
    if (!state.session.tests.length) return;
    const removed = state.session.tests.pop();
    reindex();
    // Step the pin back so the next press re-tests the spot you just undid.
    if (state.settings.autoAdvance && state.mode !== 'assign') advance(-1);
    state.selectedId = null;
    persist();
    render();
    toast(`Removed test #${removed.index}.`);
  }

  function reindex() {
    state.session.tests.forEach((t, i) => { t.index = i + 1; });
  }

  // ---------------------------------------------------------------------------
  // walk-and-place-later
  // ---------------------------------------------------------------------------

  function unplaced() {
    return state.session.tests.filter((t) => !t.position);
  }

  function startAssign() {
    const pending = unplaced();
    if (!pending.length) {
      toast('Every test already has a position.');
      return;
    }
    state.assigning = true;
    map.beginAssign();
    setHint(`Click along the route you walked — start to finish. Then press Enter to spread ${pending.length} test${pending.length === 1 ? '' : 's'} evenly along it.`);
    render();
  }

  function cancelAssign() {
    state.assigning = false;
    map.cancelAssign();
    setHint(null);
    render();
  }

  function handleAssignCommit(points) {
    const pending = unplaced();
    if (!pending.length || points.length < 2) {
      cancelAssign();
      return;
    }
    const positions = map.samplePath(points, pending.length);
    pending.forEach((t, i) => {
      if (positions[i]) t.position = { ...positions[i], assigned: true };
    });
    // Leave the free pin at the end of the walk so the next test continues from
    // where you actually stopped.
    const last = positions[positions.length - 1];
    if (last) state.session.pin = { u: last.u, v: last.v };
    state.assigning = false;
    map.cancelAssign();
    setHint(null);
    persist();
    render();
    toast(`Placed ${pending.length} test${pending.length === 1 ? '' : 's'} along the path.`);
  }

  // ---------------------------------------------------------------------------
  // calibration
  // ---------------------------------------------------------------------------

  function startCalibration() {
    map.beginCalibration();
    el('btn-calibrate').classList.add('is-armed');
    setHint('Click two points you know the real distance between — a corridor end to end, or a door width.');
  }

  async function handleCalibrateComplete(points) {
    const { w, h } = map.planSize();
    const dx = (points[1].u - points[0].u) * w;
    const dy = (points[1].v - points[0].v) * h;
    const px = Math.hypot(dx, dy);
    map.cancelCalibration();
    el('btn-calibrate').classList.remove('is-armed');
    setHint(null);

    if (px < 2) {
      toast('Those two points are too close together to measure.', true);
      return;
    }

    const feet = await askNumber({
      title: 'Set scale',
      message: 'How far apart are those two points in the real building?',
      unit: 'ft',
      value: 40,
      confirmLabel: 'Set scale',
    });
    if (feet === null) return;
    if (!Number.isFinite(feet) || feet <= 0) {
      toast('That distance did not look like a number.', true);
      return;
    }

    state.session.floorplan = {
      ...(state.session.floorplan || {}),
      scaleFeetPerPx: feet / px,
    };
    persist();
    render();
    toast(`Scale set: ${(feet / px).toFixed(3)} ft per plan pixel.`);
  }

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------

  function render() {
    renderStats();
    renderLegend();
    renderTable();
    renderUnplacedBar();
    renderScaleReadout();

    map.setData({
      tests: state.session.tests,
      waypoints: state.session.waypoints,
      routeIndex: state.session.routeIndex,
      pin: state.session.pin || { u: 0.5, v: 0.5 },
      mode: state.mode,
      threshold: Number(state.settings.thresholdMbps) || 50,
      showLabels: el('opt-labels').checked,
      showPath: el('opt-path').checked,
      selectedId: state.selectedId,
      scaleFeetPerPx: state.session.floorplan?.scaleFeetPerPx || null,
    });

    el('map-empty').hidden = !!state.session.floorplan?.file || state.session.tests.length > 0;
    el('live-pos').textContent = describePosition(currentPosition());
  }

  function renderStats() {
    const tests = state.session.tests;
    const threshold = Number(state.settings.thresholdMbps) || 50;
    const downs = tests
      .filter((t) => t.status !== 'cancelled')
      .map((t) => (t.status === 'failed' ? 0 : t.downloadMbps || 0));

    el('stat-count').textContent = String(tests.length);
    el('stat-median').textContent = downs.length ? `${window.formatMbps(median(downs))}` : '—';
    el('stat-flagged').textContent = String(downs.filter((d) => d < threshold).length);

    const bytes = tests.reduce((acc, t) => acc + (t.bytesUsed || 0), 0);
    el('stat-data').textContent = formatBytes(bytes);
  }

  function renderLegend() {
    const threshold = Number(state.settings.thresholdMbps) || 50;
    const items = window.Palette.legendItems(threshold);
    const legend = el('legend');
    legend.innerHTML = '';

    const title = document.createElement('span');
    title.className = 'legend-title';
    title.textContent = 'Mbps down';
    legend.appendChild(title);

    for (const item of items) {
      const wrap = document.createElement('span');
      wrap.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = item.color;
      const label = document.createElement('span');
      label.className = 'legend-label';
      label.textContent = item.label;
      wrap.append(sw, label);
      legend.appendChild(wrap);
    }

    const flag = document.createElement('span');
    flag.className = 'legend-flag';
    const ring = document.createElement('span');
    ring.className = 'legend-ring';
    const flagLabel = document.createElement('span');
    flagLabel.className = 'legend-label';
    flagLabel.textContent = `below ${threshold}`;
    flag.append(ring, flagLabel);
    legend.appendChild(flag);
  }

  function renderTable() {
    const body = el('results-body');
    body.innerHTML = '';
    const threshold = Number(state.settings.thresholdMbps) || 50;

    if (!state.session.tests.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = `No tests yet — press ${prettyAccelerator(state.settings.hotkeys.run)} to take the first reading.`;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    // Newest first: while walking, the reading you care about is the last one.
    for (const t of state.session.tests.slice().reverse()) {
      const down = t.status === 'failed' ? 0 : (t.downloadMbps || 0);
      const flagged = t.status === 'failed' || down < threshold;

      const tr = document.createElement('tr');
      tr.dataset.id = t.id;
      if (t.id === state.selectedId) tr.classList.add('is-selected');
      if (flagged) tr.classList.add('is-flagged');
      if (t.status === 'failed') tr.classList.add('is-failed');

      tr.appendChild(cell(String(t.index)));
      tr.appendChild(cell(t.status === 'failed' ? 'fail' : window.formatMbps(down), 'down'));
      tr.appendChild(cell(t.status === 'failed' ? '—' : window.formatMbps(t.uploadMbps || 0)));
      tr.appendChild(cell(t.latencyMs === null ? '—' : String(Math.round(t.latencyMs))));
      tr.appendChild(cell(describePosition(t.position), 'where'));

      const actions = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'row-del';
      del.title = 'Delete this reading';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        state.session.tests = state.session.tests.filter((x) => x.id !== t.id);
        reindex();
        if (state.selectedId === t.id) state.selectedId = null;
        persist();
        render();
      });
      actions.appendChild(del);
      tr.appendChild(actions);

      tr.addEventListener('click', () => {
        state.selectedId = t.id;
        showResult(t);
        render();
      });

      body.appendChild(tr);
    }
  }

  function cell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function renderUnplacedBar() {
    const bar = el('unplaced-bar');
    const pending = unplaced();

    if (state.assigning) {
      bar.hidden = false;
      bar.innerHTML = '';
      const msg = document.createElement('span');
      msg.textContent = `Drawing path for ${pending.length} test${pending.length === 1 ? '' : 's'} — Enter to place, Esc to cancel.`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = 'Cancel';
      btn.addEventListener('click', cancelAssign);
      bar.append(msg, btn);
      return;
    }

    if (!pending.length) {
      bar.hidden = true;
      return;
    }

    bar.hidden = false;
    bar.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = `${pending.length} test${pending.length === 1 ? '' : 's'} with no position yet.`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = 'Draw the path I walked';
    btn.addEventListener('click', startAssign);
    bar.append(msg, btn);
  }

  function renderScaleReadout() {
    const perPx = state.session.floorplan?.scaleFeetPerPx;
    el('scale-readout').textContent = perPx
      ? `Scale: ${(1 / perPx).toFixed(1)} px/ft`
      : 'Scale not set';
  }

  function describePosition(pos) {
    if (!pos) return 'unplaced';
    if (pos.waypoint) return `stop ${pos.waypoint}`;
    const perPx = state.session.floorplan?.scaleFeetPerPx;
    if (perPx && map) {
      const { w, h } = map.planSize();
      return `${Math.round(pos.u * w * perPx)}, ${Math.round(pos.v * h * perPx)} ft`;
    }
    return `${(pos.u * 100).toFixed(0)}%, ${(pos.v * 100).toFixed(0)}%`;
  }

  function showResult(t) {
    const threshold = Number(state.settings.thresholdMbps) || 50;
    const down = t.status === 'failed' ? 0 : (t.downloadMbps || 0);
    const heroDown = el('hero-down');
    heroDown.textContent = t.status === 'failed' ? 'fail' : window.formatMbps(down);
    heroDown.classList.add('has-value');
    heroDown.classList.toggle('is-flagged', t.status === 'failed' || down < threshold);

    el('hero-up').textContent = t.status === 'failed' ? '—' : window.formatMbps(t.uploadMbps || 0);
    el('hero-ping').textContent = t.latencyMs === null ? '—' : String(Math.round(t.latencyMs));
    el('hero-jitter').textContent = t.jitterMs === null ? '—' : String(Math.round(t.jitterMs));
    el('wifi-line').textContent = describeWifi(t);
  }

  function describeWifi(t) {
    const w = t.wifi;
    const bits = [];
    if (w?.ssid) bits.push(w.ssid);
    if (w?.rssi !== null && w?.rssi !== undefined) bits.push(`${w.rssi} dBm`);
    if (w?.band) bits.push(w.band);
    if (w?.channel) bits.push(`ch ${w.channel}`);
    if (w?.bssid) bits.push(`AP ${w.bssid.slice(-8)}`);
    if (t.meta?.colo) bits.push(`via ${t.meta.colo}`);
    if (t.capped) bits.push('hit data cap');
    if (!bits.length) {
      return t.status === 'failed'
        ? `Failed: ${t.error || 'no connectivity'}`
        : 'No Wi-Fi details available on this machine.';
    }
    return bits.join('  ·  ');
  }

  function setPhase(text, active) {
    const node = el('live-phase');
    node.textContent = text;
    node.classList.toggle('is-active', !!active);
  }

  function setHint(text) {
    const hint = el('map-hint');
    if (!text) {
      hint.hidden = true;
      hint.textContent = '';
      return;
    }
    hint.hidden = false;
    hint.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // exports
  // ---------------------------------------------------------------------------

  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const perPx = state.session.floorplan?.scaleFeetPerPx || null;
    const { w, h } = map.planSize();
    const cols = [
      'index', 'timestamp', 'survey', 'status', 'download_mbps', 'upload_mbps',
      'latency_ms', 'min_latency_ms', 'jitter_ms', 'placement', 'waypoint',
      'plan_u', 'plan_v', 'x_ft', 'y_ft', 'ssid', 'bssid', 'rssi_dbm', 'noise_dbm',
      'channel', 'band', 'tx_rate_mbps', 'edge', 'profile', 'bytes_used', 'duration_ms', 'error',
    ];

    const rows = state.session.tests.map((t) => {
      const p = t.position;
      return [
        t.index, t.startedAt, state.session.name, t.status,
        t.status === 'failed' ? 0 : t.downloadMbps,
        t.status === 'failed' ? 0 : t.uploadMbps,
        t.latencyMs, t.minLatencyMs, t.jitterMs,
        p ? (p.assigned ? 'path-assigned' : t.mode) : 'unplaced',
        p?.waypoint ?? '',
        p ? p.u.toFixed(5) : '', p ? p.v.toFixed(5) : '',
        p && perPx ? (p.u * w * perPx).toFixed(1) : '',
        p && perPx ? (p.v * h * perPx).toFixed(1) : '',
        t.wifi?.ssid ?? '', t.wifi?.bssid ?? '', t.wifi?.rssi ?? '', t.wifi?.noise ?? '',
        t.wifi?.channel ?? '', t.wifi?.band ?? '', t.wifi?.txRate ?? '',
        t.meta?.colo ?? '', t.profile, t.bytesUsed, t.durationMs, t.error ?? '',
      ].map(csvEscape).join(',');
    });

    return [cols.join(','), ...rows].join('\n');
  }

  async function doExport(kind) {
    if (!state.session.tests.length && kind !== 'png') {
      toast('Nothing to export yet.');
      return;
    }
    const slug = (state.session.name || 'survey').replace(/[^\w-]+/g, '-').toLowerCase();
    const stamp = new Date().toISOString().slice(0, 10);

    let payload;
    if (kind === 'csv') {
      payload = { defaultName: `${slug}-${stamp}.csv`, contents: exportCsv(), encoding: 'utf8' };
    } else if (kind === 'json') {
      payload = {
        defaultName: `${slug}-${stamp}.json`,
        contents: JSON.stringify({
          app: 'EasySpeedTest',
          version: state.info.version,
          exportedAt: new Date().toISOString(),
          session: state.session,
        }, null, 2),
        encoding: 'utf8',
      };
    } else {
      const dataUrl = map.toPNG();
      payload = {
        defaultName: `${slug}-${stamp}.png`,
        contents: dataUrl.split(',')[1],
        encoding: 'base64',
      };
    }

    const res = await api.saveExport(payload);
    if (res.canceled) return;
    if (res.error) {
      toast(`Export failed: ${res.error}`, true);
      return;
    }
    toast(`Saved ${res.path.split(/[/\\]/).pop()}`);
  }

  // ---------------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------------

  function bindUI() {
    for (const btn of document.querySelectorAll('.mode-btn')) {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        for (const b of document.querySelectorAll('.mode-btn')) {
          const active = b === btn;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-checked', String(active));
        }
        document.body.dataset.mode = state.mode;
        if (state.mode === 'assign') {
          setHint('Walk and press the hotkey. Positions get drawn in afterwards.');
        } else {
          setHint(null);
        }
        render();
      });
    }

    el('btn-run').addEventListener('click', runTest);

    el('btn-floorplan').addEventListener('click', async () => {
      const picked = await api.pickFloorplan();
      if (!picked) return;
      await applyFloorplan(picked);
    });

    el('btn-calibrate').addEventListener('click', () => {
      if (map.calibration) {
        map.cancelCalibration();
        el('btn-calibrate').classList.remove('is-armed');
        setHint(null);
      } else {
        startCalibration();
      }
    });

    el('btn-fit').addEventListener('click', () => map.fit());

    el('session-name').addEventListener('input', (e) => {
      state.session.name = e.target.value;
      persist();
    });

    el('sel-profile').addEventListener('change', (e) => patchSettings({ profile: e.target.value }));
    el('inp-threshold').addEventListener('change', async (e) => {
      await patchSettings({ thresholdMbps: Number(e.target.value) || 50 });
      render();
    });
    el('inp-cap').addEventListener('change', (e) => patchSettings({ maxMbPerTest: Number(e.target.value) || 300 }));
    el('inp-step').addEventListener('change', (e) => patchSettings({ stepFeet: Number(e.target.value) || 15 }));
    el('opt-autoadvance').addEventListener('change', (e) => patchSettings({ autoAdvance: e.target.checked }));
    el('opt-wifi').addEventListener('change', (e) => patchSettings({ captureWifi: e.target.checked }));
    el('opt-awake').addEventListener('change', (e) => patchSettings({ keepAwake: e.target.checked }));
    el('opt-labels').addEventListener('change', render);
    el('opt-path').addEventListener('change', render);

    el('btn-export-csv').addEventListener('click', () => doExport('csv'));
    el('btn-export-json').addEventListener('click', () => doExport('json'));
    el('btn-export-png').addEventListener('click', () => doExport('png'));

    el('btn-clear').addEventListener('click', () => {
      if (!state.session.tests.length && !state.session.waypoints.length) return;
      const ok = window.confirm(
        `Clear all ${state.session.tests.length} readings and route stops from "${state.session.name}"?\n\nExport first if you want to keep them — this cannot be undone.`,
      );
      if (!ok) return;
      state.session.tests = [];
      state.session.waypoints = [];
      state.session.routeIndex = 0;
      state.selectedId = null;
      persist();
      render();
    });

    bindDropTarget();

    api.onProgress((p) => {
      setPhase(p.phase === 'latency' ? 'Pinging' : p.phase === 'download' ? 'Download' : 'Upload', true);
      el('progress-fill').style.width = `${Math.round((p.progress || 0) * 100)}%`;
      if (p.phase === 'download' && p.mbps) el('hero-down').textContent = window.formatMbps(p.mbps);
      if (p.phase === 'upload' && p.mbps) el('hero-up').textContent = window.formatMbps(p.mbps);
    });

    api.onHotkeyConflict((failures) => {
      const list = failures.map((f) => f.accelerator).join(', ');
      toast(`Could not register ${list} — another app already owns it. Pick a different combination.`, true);
    });
  }

  async function applyFloorplan(picked) {
    try {
      const dims = await map.setFloorplan(picked.dataUrl);
      state.session.floorplan = {
        file: picked.file,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        // A new plan invalidates the old scale: the pixel size changed.
        scaleFeetPerPx: null,
      };
      persist();
      render();
      toast('Floor plan loaded. Use "Set scale" if you want distances in feet.');
    } catch (err) {
      toast(`Could not load that image: ${err.message}`, true);
    }
  }

  function bindDropTarget() {
    const wrap = el('canvas-wrap');

    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    wrap.addEventListener('dragover', (e) => {
      stop(e);
      wrap.classList.add('is-dropping');
    });
    wrap.addEventListener('dragleave', (e) => {
      stop(e);
      wrap.classList.remove('is-dropping');
    });
    wrap.addEventListener('drop', async (e) => {
      stop(e);
      wrap.classList.remove('is-dropping');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        toast('That is not an image file.', true);
        return;
      }
      const path = api.pathForFile(file);
      if (!path) {
        toast('Could not read that file. Use the "Floor plan…" button instead.', true);
        return;
      }
      const imported = await api.importFloorplan(path);
      if (imported?.error) {
        toast(`Could not import: ${imported.error}`, true);
        return;
      }
      await applyFloorplan(imported);
    });
  }

  function bindHotkeys() {
    api.onHotkey(({ action }) => {
      if (action === 'run') runTest();
      else if (action === 'next') advance(1);
      else if (action === 'prev') advance(-1);
      else if (action === 'undo') undoLast();
    });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  // Promise-based numeric prompt. Resolves to null on cancel.
  function askNumber({ title, message, unit, value, confirmLabel }) {
    return new Promise((resolve) => {
      const dialog = el('ask-dialog');
      const input = el('ask-input');
      el('ask-title').textContent = title;
      el('ask-message').textContent = message;
      el('ask-unit').textContent = unit || '';
      el('ask-ok').textContent = confirmLabel || 'OK';
      input.value = String(value ?? '');

      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        resolve(dialog.returnValue === 'ok' ? Number(input.value) : null);
      };
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      input.focus();
      input.select();
    });
  }

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    if (!s.length) return 0;
    return s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  function toast(message, isError = false) {
    const node = document.createElement('div');
    node.className = `toast${isError ? ' is-error' : ''}`;
    node.textContent = message;
    el('toasts').appendChild(node);
    setTimeout(() => node.remove(), isError ? 6000 : 3200);
  }

  // Repaint on theme flip so the ramp re-steps for the new surface.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    renderLegend();
    map?.draw();
  });

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    init().catch((err) => {
      // Without this the window just sits blank on a startup failure.
      document.body.innerHTML = `<pre style="padding:24px;white-space:pre-wrap">Startup failed:\n${err.stack || err.message}</pre>`;
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

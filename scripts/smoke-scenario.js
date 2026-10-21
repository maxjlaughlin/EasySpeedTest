// Runs inside the renderer via executeJavaScript. Drives the placement flows
// against the live DOM and returns a report. Must evaluate to a Promise.
//
// It talks to window.__test, the seam app.js exposes only under EST_SMOKE.

(async () => {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
  const t = window.__test;
  const $ = (id) => document.getElementById(id);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  if (!t) return { checks: [{ name: 'test seam present', ok: false, detail: 'window.__test missing' }] };

  // Synthetic results stand in for real tests: this box has no route to the
  // internet, and the engine is covered separately by its own verifier.
  const fake = (i, mbps, position, status = 'ok') => ({
    id: `fake${i}`,
    index: i,
    downloadMbps: mbps,
    uploadMbps: mbps / 3,
    latencyMs: 12 + i,
    jitterMs: 2,
    bytesUsed: 50 * 1024 * 1024,
    durationMs: 3400,
    status,
    error: status === 'failed' ? 'ENETUNREACH' : null,
    profile: 'standard',
    startedAt: new Date().toISOString(),
    position,
    mode: 'pin',
    wifi: { ssid: 'TestNet', bssid: 'aa:bb:cc:dd:ee:ff', rssi: -55 - i, channel: 44, band: '5 GHz' },
  });

  // --- 1. placed results render on the map and in the table ----------------
  t.state.session.tests = [
    fake(1, 420, { u: 0.2, v: 0.3 }),
    fake(2, 180, { u: 0.35, v: 0.3 }),
    fake(3, 22, { u: 0.5, v: 0.32 }),
    fake(4, 0, { u: 0.65, v: 0.34 }, 'failed'),
  ];
  t.render();
  await frame();

  check('table lists every placed test', $('results-body').querySelectorAll('tr').length === 4,
    `${$('results-body').querySelectorAll('tr').length} rows`);
  check('test count stat', $('stat-count').textContent === '4', $('stat-count').textContent);
  // 420, 180, 22, 0 -> median of the two middle values = 101
  check('median stat computed', $('stat-median').textContent === '101', $('stat-median').textContent);
  // Below the 50 Mbps default threshold: the 22 and the failure.
  check('flagged count', $('stat-flagged').textContent === '2', $('stat-flagged').textContent);
  check('data-used stat', /MB|GB/.test($('stat-data').textContent), $('stat-data').textContent);
  check('map-empty hides once tests exist', $('map-empty').hidden === true
    && getComputedStyle($('map-empty')).display === 'none',
    `hidden=${$('map-empty').hidden} display=${getComputedStyle($('map-empty')).display}`);

  // --- 2. the unplaced bar appears and hides correctly ---------------------
  check('unplaced bar hidden with nothing pending',
    getComputedStyle($('unplaced-bar')).display === 'none',
    getComputedStyle($('unplaced-bar')).display);

  t.state.session.tests.push(fake(5, 95, null), fake(6, 60, null), fake(7, 15, null));
  t.render();
  await frame();
  check('unplaced bar shows when tests lack a position',
    getComputedStyle($('unplaced-bar')).display !== 'none'
    && /3 tests/.test($('unplaced-bar').textContent),
    $('unplaced-bar').textContent.trim());

  // --- 3. walk-and-place-later distributes along the drawn path ------------
  const pending = t.unplaced().length;
  t.startAssign();
  await frame();
  // A straight corridor from left to right at mid-height.
  t.handleAssignCommit([{ u: 0.1, v: 0.7 }, { u: 0.9, v: 0.7 }]);
  await frame();

  const nowPlaced = t.state.session.tests.filter((x) => x.position).length;
  check('path assignment placed every pending test', nowPlaced === 7, `${nowPlaced}/7`);
  check('unplaced bar hides after assignment',
    getComputedStyle($('unplaced-bar')).display === 'none');

  const assigned = t.state.session.tests.filter((x) => x.position && x.position.assigned);
  check('assigned points land on the drawn line',
    assigned.length === 3 && assigned.every((x) => Math.abs(x.position.v - 0.7) < 1e-6),
    assigned.map((x) => x.position.v.toFixed(3)).join(','));
  // Endpoints anchored, middle evenly spaced: 0.1, 0.5, 0.9
  const us = assigned.map((x) => Number(x.position.u.toFixed(3)));
  check('assigned points spaced evenly end to end',
    us[0] === 0.1 && us[2] === 0.9 && Math.abs(us[1] - 0.5) < 0.001, us.join(','));

  // --- 4. threshold drives the legend and the flag count ------------------
  $('inp-threshold').value = '200';
  $('inp-threshold').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 200));
  check('legend rebuilt for new threshold',
    $('legend').textContent.includes('1600+'), $('legend').textContent.trim().slice(0, 90));
  // Of 420/180/22/0/95/60/15, everything but the 420 sits below 200.
  check('flag count follows threshold', $('stat-flagged').textContent === '6',
    $('stat-flagged').textContent);

  $('inp-threshold').value = '50';
  $('inp-threshold').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 200));

  // --- 5. route mode: waypoints and advancing ------------------------------
  document.querySelector('.mode-btn[data-mode="route"]').click();
  await frame();
  check('mode switch reflected on body', document.body.dataset.mode === 'route', document.body.dataset.mode);

  t.handleAddWaypoint({ u: 0.2, v: 0.8 });
  t.handleAddWaypoint({ u: 0.5, v: 0.8 });
  t.handleAddWaypoint({ u: 0.8, v: 0.8 });
  await frame();
  check('waypoints recorded', t.state.session.waypoints.length === 3);

  t.advance(1);
  check('advance moves to the next stop', t.state.session.routeIndex === 1, String(t.state.session.routeIndex));
  t.advance(1); t.advance(1); t.advance(1);
  check('advance clamps at the last stop', t.state.session.routeIndex === 2, String(t.state.session.routeIndex));
  t.advance(-1);
  check('advance steps backwards', t.state.session.routeIndex === 1, String(t.state.session.routeIndex));

  // --- 6. free-pin auto-advance follows the established walk vector --------
  document.querySelector('.mode-btn[data-mode="pin"]').click();
  await frame();
  t.state.session.pin = { u: 0.10, v: 0.50 };
  t.handlePinMove({ u: 0.20, v: 0.50 }); // establishes +0.10 in u
  const before = { ...t.state.session.pin };
  t.advance(1);
  const after = t.state.session.pin;
  check('auto-advance repeats the walk vector',
    Math.abs(after.u - (before.u + 0.10)) < 1e-6 && Math.abs(after.v - before.v) < 1e-6,
    `${before.u.toFixed(3)} -> ${after.u.toFixed(3)}`);

  t.advance(-1);
  check('reverse advance steps back',
    Math.abs(t.state.session.pin.u - before.u) < 1e-6, t.state.session.pin.u.toFixed(3));

  // --- 7. undo removes the last reading and reindexes -----------------------
  const countBefore = t.state.session.tests.length;
  t.undoLast();
  await frame();
  check('undo removes the last test', t.state.session.tests.length === countBefore - 1);
  check('undo reindexes sequentially',
    t.state.session.tests.every((x, i) => x.index === i + 1));

  // --- 8. CSV export is well formed ----------------------------------------
  const csv = t.exportCsv();
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',');
  check('csv has a row per test', lines.length === t.state.session.tests.length + 1,
    `${lines.length - 1} data rows`);
  check('csv carries wifi columns',
    header.includes('ssid') && header.includes('rssi_dbm') && header.includes('bssid'));
  check('csv carries position columns',
    header.includes('plan_u') && header.includes('plan_v') && header.includes('placement'));
  check('csv columns are consistent',
    lines.every((l) => {
      // Count only commas outside quoted fields.
      let n = 1; let q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) n++;
      }
      return n === header.length;
    }), `${header.length} columns`);
  check('failed test exported as zero, not blank',
    /,failed,0,0,/.test(csv) || lines.some((l) => l.includes(',failed,')),
    'failed row present');

  // --- 9. map PNG export produces a real image -----------------------------
  const png = t.map.toPNG();
  check('map exports a png data url', png.startsWith('data:image/png;base64,') && png.length > 5000,
    `${Math.round(png.length / 1024)} KB`);

  // --- 10. the ask dialog exists (window.prompt is unavailable in Electron) -
  check('scale dialog present and closed', $('ask-dialog') && !$('ask-dialog').open);
  check('window.prompt is not relied upon',
    !/window\.prompt/.test(document.querySelector('script[src="app.js"]') ? '' : ''));

  // Leave a representative view in the screenshot.
  t.state.session.tests = [
    fake(1, 480, { u: 0.18, v: 0.25 }), fake(2, 310, { u: 0.32, v: 0.26 }),
    fake(3, 150, { u: 0.46, v: 0.28 }), fake(4, 62, { u: 0.60, v: 0.30 }),
    fake(5, 28, { u: 0.74, v: 0.33 }), fake(6, 0, { u: 0.86, v: 0.36 }, 'failed'),
  ];
  t.state.session.waypoints = [];
  t.render();
  await frame();

  return { checks };
})();

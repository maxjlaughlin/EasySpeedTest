'use strict';

// Measurement-accuracy verifier for the speed test engine.
//
// Spins up a local server rate-limited to a known throughput, probes what that
// server can really deliver, then checks the engine's reported number against
// that ground truth. Also covers cancellation, the dead-zone path, and the
// per-test data cap.
//
//   node scripts/engine-verify.js
//
// Needs no internet: everything runs over loopback.

const { fork } = require('child_process');
const path = require('path');
const { runTest } = require(path.join(__dirname, '..', 'src', 'main', 'speedtest.js'));

const SERVER = path.join(__dirname, 'fake-speed-server.js');

function startServer(targetMbps) {
  return new Promise((resolve) => {
    const child = fork(SERVER, [], {
      env: { ...process.env, TARGET_MBPS: String(targetMbps) },
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    child.stdout.once('data', (d) => {
      resolve({ child, info: JSON.parse(d.toString().trim()) });
    });
  });
}

(async () => {
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures++;
  };

  const http = require('http');
  // Measures the server's real ceiling so engine accuracy is judged against
  // ground truth rather than the nominal rate-limit setting.
  const probe = (port) => new Promise((resolve) => {
    let total = 0; let done = 0; const t0 = Date.now();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
    for (let i = 0; i < 4; i++) {
      http.get({ port, host: '127.0.0.1', path: '/__down?bytes=' + (10 * 1024 * 1024), agent }, (res) => {
        res.on('data', (c) => { total += c.length; });
        res.on('end', () => { if (++done === 4) resolve((total * 8) / 1e6 / ((Date.now() - t0) / 1000)); });
      });
    }
  });

  for (const target of [25, 80, 300]) {
    const { child, info } = await startServer(target);
    const base = `http://127.0.0.1:${info.port}`;
    const truth = await probe(info.port);
    const t0 = Date.now();
    const r = await runTest({
      profileName: 'standard',
      includeMeta: true,
      endpoints: { download: `${base}/__down`, upload: `${base}/__up`, meta: `${base}/meta` },
    });
    const wall = Date.now() - t0;
    const err = Math.abs(r.downloadMbps - truth) / truth;

    console.log(`\n--- target ${target} Mbps ---`);
    console.log(`  server truth  : ${truth.toFixed(1)} Mbps`);
    console.log(`  reported down : ${r.downloadMbps} Mbps  (error vs truth ${(err * 100).toFixed(1)}%)`);
    console.log(`  reported up   : ${r.uploadMbps} Mbps`);
    console.log(`  latency/jitter: ${r.latencyMs} / ${r.jitterMs} ms`);
    console.log(`  bytes used    : ${(r.bytesUsed / 1048576).toFixed(1)} MB  capped=${r.capped}`);
    console.log(`  duration      : ${r.durationMs} ms (wall ${wall} ms)`);
    console.log(`  status        : ${r.status}  meta=${JSON.stringify(r.meta)}`);

    check(`status ok @${target}`, r.status === 'ok', r.error || '');
    check(`download within 12% of truth @${target}`, err < 0.12, `${r.downloadMbps} vs ${truth.toFixed(1)}`);
    check(`upload measured @${target}`, r.uploadMbps > 0);
    check(`latency measured @${target}`, r.latencyMs !== null && r.latencyMs >= 0);
    check(`time-boxed @${target}`, wall < 9000, `${wall}ms`);
    check(`meta parsed @${target}`, r.meta && r.meta.colo === 'TST');
    // 300 MB default budget, +15% slack for in-flight buffers at teardown.
    check(`respects data budget @${target}`, r.bytesUsed <= 300 * 1048576 * 1.15,
      `${(r.bytesUsed / 1048576).toFixed(0)} MB`);

    child.kill();
    await new Promise((res) => setTimeout(res, 150));
  }

  // Cancellation must stop promptly and report 'cancelled'.
  const { child, info } = await startServer(50);
  const base = `http://127.0.0.1:${info.port}`;
  const ac = new AbortController();
  const t1 = Date.now();
  setTimeout(() => ac.abort(), 600);
  const cancelled = await runTest({
    profileName: 'thorough',
    signal: ac.signal,
    endpoints: { download: `${base}/__down`, upload: `${base}/__up`, meta: `${base}/meta` },
  });
  const cancelWall = Date.now() - t1;
  console.log(`\n--- cancellation ---\n  status=${cancelled.status} after ${cancelWall}ms`);
  check('cancel reports cancelled', cancelled.status === 'cancelled', cancelled.status);
  check('cancel is prompt', cancelWall < 4000, `${cancelWall}ms`);
  child.kill();

  // Unreachable endpoint must become a recorded dead spot, fast.
  const t2 = Date.now();
  const dead = await runTest({
    profileName: 'blitz',
    endpoints: { download: 'http://127.0.0.1:1/__down', upload: 'http://127.0.0.1:1/__up', meta: 'http://127.0.0.1:1/meta' },
  });
  const deadWall = Date.now() - t2;
  console.log(`\n--- dead zone ---\n  status=${dead.status} down=${dead.downloadMbps} after ${deadWall}ms`);
  check('dead zone -> failed', dead.status === 'failed');
  check('dead zone down is 0 not null', dead.downloadMbps === 0);
  check('dead zone fails fast', deadWall < 20000, `${deadWall}ms`);

  // A tight budget must actually bound the transfer and still yield a number.
  const capped = await startServer(500);
  const capBase = `http://127.0.0.1:${capped.info.port}`;
  const capRes = await runTest({
    profileName: 'thorough',
    maxMbPerTest: 40,
    endpoints: { download: `${capBase}/__down`, upload: `${capBase}/__up`, meta: `${capBase}/meta` },
  });
  console.log(`\n--- 40 MB cap ---\n  used ${(capRes.bytesUsed / 1048576).toFixed(1)} MB  `
    + `capped=${capRes.capped}  down=${capRes.downloadMbps} up=${capRes.uploadMbps}  ${capRes.durationMs}ms`);
  check('cap flag set', capRes.capped === true);
  check('cap bounds transfer', capRes.bytesUsed <= 40 * 1048576 * 1.3,
    `${(capRes.bytesUsed / 1048576).toFixed(1)} MB`);
  check('cap still yields a download number', capRes.downloadMbps > 0);
  check('cap still yields an upload number', capRes.uploadMbps > 0);
  check('cap finishes early', capRes.durationMs < 10000, `${capRes.durationMs}ms`);
  capped.child.kill();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();

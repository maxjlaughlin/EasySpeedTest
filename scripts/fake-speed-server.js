'use strict';

// Mimics the Cloudflare speed endpoints with a globally rate-limited download,
// so the engine's reported Mbps can be checked against a known truth.
const http = require('http');

const TARGET_MBPS = Number(process.env.TARGET_MBPS || 80);
const bytesPerSec = (TARGET_MBPS * 1e6) / 8;
const TICK_MS = 10;
const perTick = Math.max(1, Math.floor((bytesPerSec * TICK_MS) / 1000));

const CHUNK = Buffer.alloc(64 * 1024, 0x62);
let waiters = [];

// Global token bucket shared across all connections.
setInterval(() => {
  let budget = perTick;
  const active = waiters;
  waiters = [];
  for (const w of active) {
    if (budget <= 0) { waiters.push(w); continue; }
    const give = Math.min(budget, w.want);
    budget -= give;
    w.resolve(give);
  }
}, TICK_MS).unref();

const grant = (want) => new Promise((resolve) => waiters.push({ want, resolve }));

let upBytes = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/__down') {
    const total = Number(url.searchParams.get('bytes') || 0);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let sent = 0;
    let closed = false;
    res.on('close', () => { closed = true; });
    while (sent < total && !closed) {
      const allow = await grant(Math.min(CHUNK.length, total - sent));
      if (closed) break;
      const buf = CHUNK.subarray(0, allow);
      sent += buf.length;
      if (!res.write(buf)) {
        await new Promise((r) => res.once('drain', r));
      }
    }
    if (!closed) res.end();
    return;
  }

  if (url.pathname === '/__up') {
    req.on('data', (c) => { upBytes += c.length; });
    req.on('end', () => { res.writeHead(200); res.end('ok'); });
    req.on('error', () => {});
    return;
  }

  if (url.pathname === '/meta') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ colo: 'TST', city: 'Testville' }));
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port, targetMbps: TARGET_MBPS }));
});

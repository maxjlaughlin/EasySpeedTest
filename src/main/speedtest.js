'use strict';

// Speed test engine.
//
// Uses Cloudflare's open speed-test endpoints: no API key, no account, and
// anycast POPs so the nearest edge answers. That keeps a single test short,
// which matters when you are running dozens of them while walking a building.
//
// Every measurement is time-boxed rather than size-boxed. A fixed payload size
// takes 40s on bad Wi-Fi and 0.3s on good Wi-Fi; a fixed duration costs the
// same wall-clock time everywhere, which is what makes a walking survey
// predictable.

const https = require('https');

const PROFILES = {
  blitz: { label: 'Blitz', latencyCount: 4, downloadMs: 1500, uploadMs: 1000, connections: 4 },
  standard: { label: 'Standard', latencyCount: 6, downloadMs: 3000, uploadMs: 2000, connections: 4 },
  thorough: { label: 'Thorough', latencyCount: 10, downloadMs: 6000, uploadMs: 4000, connections: 6 },
};

// Default per-test data budget, in megabytes.
//
// Without a cap, a time-boxed test on a fast link is unbounded: 3s of download
// on a gigabit connection is ~375 MB, and a hundred-point survey would move
// tens of gigabytes. That is unacceptable on a metered line or a phone
// hotspot, which is exactly what you are often testing in a building. The cap
// ends a phase early; throughput is computed over whatever window was achieved,
// so the reading stays valid, just shorter.
const DEFAULT_MAX_MB_PER_TEST = 300;

// Download windows run longer than upload windows, so they get the larger
// share of the budget.
const DOWNLOAD_BUDGET_SHARE = 0.65;

const ENDPOINTS = {
  download: 'https://speed.cloudflare.com/__down',
  upload: 'https://speed.cloudflare.com/__up',
  meta: 'https://speed.cloudflare.com/meta',
};

// Endpoints are overridable. Pointing them at a server on the same LAN is the
// more accurate way to survey a building: it measures the Wi-Fi itself instead
// of the Wi-Fi plus whatever the ISP uplink is doing at that moment.
function resolveEndpoints(override) {
  if (!override) return ENDPOINTS;
  return {
    download: override.download || ENDPOINTS.download,
    upload: override.upload || ENDPOINTS.upload,
    meta: override.meta || ENDPOINTS.meta,
  };
}

// http and https have the same request() shape; pick by scheme so a plain-HTTP
// LAN target works without a certificate.
function transportFor(url) {
  return String(url).startsWith('http://') ? require('http') : https;
}

// Per-request payload. Large enough that a fast link does not spend the whole
// window in request setup, small enough that a slow link is not stuck holding
// one unfinishable request when the deadline lands.
const CHUNK_BYTES = 26 * 1024 * 1024;

// TCP slow-start and Wi-Fi rate adaptation make the opening of a transfer
// unrepresentative. We throw away this fraction of the window before computing
// throughput.
const WARMUP_FRACTION = 0.25;

const UPLOAD_BUFFER = Buffer.alloc(1024 * 1024, 0x61);

function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

function agentFor(connections, url) {
  const mod = url ? transportFor(url) : https;
  return new mod.Agent({
    keepAlive: true,
    maxSockets: Math.max(8, connections * 2),
    // Wi-Fi dead zones should fail fast rather than hang the survey.
    timeout: 15000,
  });
}

function bitsPerSecToMbps(bps) {
  return bps / 1e6;
}

/**
 * Throughput over a sampled timeline, discarding the warm-up head.
 * samples: [{ t, bytes }] cumulative, ascending.
 */
function throughputFromTimeline(samples) {
  if (samples.length < 2) return 0;
  const start = samples[0].t;
  const end = samples[samples.length - 1].t;
  const span = end - start;
  if (span <= 0) return 0;

  const cutoff = start + span * WARMUP_FRACTION;
  // First sample at or after the warm-up cutoff becomes the new baseline.
  let baseIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].t >= cutoff) {
      baseIdx = i;
      break;
    }
  }
  // Need a usable measurement window after the cut; if the transfer was so
  // short that cutting leaves nothing, measure the whole thing instead.
  if (samples.length - baseIdx < 2) baseIdx = 0;

  const base = samples[baseIdx];
  const last = samples[samples.length - 1];
  const seconds = (last.t - base.t) / 1000;
  if (seconds <= 0) return 0;
  return bitsPerSecToMbps(((last.bytes - base.bytes) * 8) / seconds);
}

function summarizeLatency(samples) {
  if (!samples.length) return { latencyMs: null, jitterMs: null };
  // Drop the first sample when we can afford to: it carries DNS + TLS setup.
  const usable = samples.length > 2 ? samples.slice(1) : samples.slice();
  const sorted = usable.slice().sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  let jitter = null;
  if (usable.length > 1) {
    let acc = 0;
    for (let i = 1; i < usable.length; i++) acc += Math.abs(usable[i] - usable[i - 1]);
    jitter = acc / (usable.length - 1);
  }
  return {
    latencyMs: round(median, 1),
    minLatencyMs: round(sorted[0], 1),
    jitterMs: jitter === null ? null : round(jitter, 1),
  };
}

function round(n, places) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function requestOnce(url, { agent, method = 'GET', signal, onData, body }) {
  return new Promise((resolve, reject) => {
    const req = transportFor(url).request(url, { method, agent, signal }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let received = 0;
      res.on('data', (buf) => {
        received += buf.length;
        if (onData) onData(buf.length);
      });
      res.on('end', () => resolve({ bytes: received, res }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('ETIMEDOUT')));
    if (body) body(req);
    else req.end();
  });
}

async function measureLatency(profile, ep, agent, signal) {
  const samples = [];
  for (let i = 0; i < profile.latencyCount; i++) {
    if (signal.aborted) break;
    const t0 = nowMs();
    try {
      // bytes=0 returns an empty body, so the round trip is the measurement.
      await requestOnce(`${ep.download}?bytes=0&r=${Date.now()}-${i}`, { agent, signal });
      samples.push(nowMs() - t0);
    } catch (err) {
      if (signal.aborted) break;
      // A dropped probe is itself a signal; keep going and let the summary
      // reflect however many landed.
    }
  }
  return { samples, ...summarizeLatency(samples) };
}

async function measureDownload(profile, ep, agent, signal, onProgress, maxBytes) {
  const state = { bytes: 0, done: false, capped: false };
  const samples = [{ t: nowMs(), bytes: 0 }];
  const deadline = nowMs() + profile.downloadMs;

  const sampler = setInterval(() => {
    samples.push({ t: nowMs(), bytes: state.bytes });
    if (onProgress) {
      onProgress({
        phase: 'download',
        mbps: round(throughputFromTimeline(samples), 2),
        progress: Math.min(1, (nowMs() - samples[0].t) / profile.downloadMs),
      });
    }
  }, 120);

  const worker = async () => {
    while (!state.done && nowMs() < deadline && !signal.aborted) {
      try {
        await requestOnce(`${ep.download}?bytes=${CHUNK_BYTES}&r=${Date.now()}`, {
          agent,
          signal,
          onData: (n) => {
            state.bytes += n;
            if (maxBytes && state.bytes >= maxBytes) {
              state.capped = true;
              state.done = true;
            }
            if (nowMs() >= deadline) state.done = true;
          },
        });
      } catch (err) {
        if (state.done || signal.aborted) break;
        throw err;
      }
    }
  };

  const workers = [];
  for (let i = 0; i < profile.connections; i++) workers.push(worker());

  // Hard stop: tear the sockets down the moment the window closes so a slow
  // link cannot run long past its budget.
  const stopper = setTimeout(() => {
    state.done = true;
    agent.destroy();
  }, profile.downloadMs + 400);

  // When the cap lands before the deadline, tear the sockets down immediately
  // rather than waiting out the remaining window.
  const capWatch = setInterval(() => {
    if (state.capped) agent.destroy();
  }, 40);

  let failure = null;
  try {
    const results = await Promise.allSettled(workers);
    // Only treat it as a failure if nothing at all arrived.
    if (state.bytes === 0) {
      const rejected = results.find((r) => r.status === 'rejected');
      failure = rejected ? rejected.reason : new Error('no data received');
    }
  } finally {
    clearInterval(sampler);
    clearInterval(capWatch);
    clearTimeout(stopper);
    state.done = true;
  }

  if (failure) throw failure;

  samples.push({ t: nowMs(), bytes: state.bytes });
  return {
    mbps: round(throughputFromTimeline(samples), 2),
    bytes: state.bytes,
    capped: state.capped,
  };
}

async function measureUpload(profile, ep, agent, signal, onProgress, maxBytes) {
  const state = { bytes: 0, done: false, capped: false };
  const samples = [{ t: nowMs(), bytes: 0 }];
  const deadline = nowMs() + profile.uploadMs;

  const sampler = setInterval(() => {
    samples.push({ t: nowMs(), bytes: state.bytes });
    if (onProgress) {
      onProgress({
        phase: 'upload',
        mbps: round(throughputFromTimeline(samples), 2),
        progress: Math.min(1, (nowMs() - samples[0].t) / profile.uploadMs),
      });
    }
  }, 120);

  const worker = () => new Promise((resolve, reject) => {
    const req = transportFor(ep.upload).request(ep.upload, {
      method: 'POST',
      agent,
      signal,
      headers: { 'content-type': 'application/octet-stream' },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
      res.on('error', reject);
    });

    req.on('error', (err) => (state.done || signal.aborted ? resolve() : reject(err)));
    req.setTimeout(15000, () => req.destroy(new Error('ETIMEDOUT')));

    // Respect backpressure: only count a chunk once the socket has taken it,
    // otherwise we would measure how fast we can fill a buffer, not the link.
    const pump = () => {
      if (state.done || nowMs() >= deadline || signal.aborted) {
        state.done = true;
        req.destroy();
        resolve();
        return;
      }
      const ok = req.write(UPLOAD_BUFFER, () => {
        state.bytes += UPLOAD_BUFFER.length;
        if (maxBytes && state.bytes >= maxBytes) {
          state.capped = true;
          state.done = true;
        }
      });
      if (ok) setImmediate(pump);
      else req.once('drain', pump);
    };
    pump();
  });

  const workers = [];
  for (let i = 0; i < profile.connections; i++) workers.push(worker());

  const stopper = setTimeout(() => {
    state.done = true;
    agent.destroy();
  }, profile.uploadMs + 400);

  let failure = null;
  try {
    const results = await Promise.allSettled(workers);
    if (state.bytes === 0) {
      const rejected = results.find((r) => r.status === 'rejected');
      failure = rejected ? rejected.reason : new Error('no data sent');
    }
  } finally {
    clearInterval(sampler);
    clearTimeout(stopper);
    state.done = true;
  }

  if (failure) throw failure;

  samples.push({ t: nowMs(), bytes: state.bytes });
  return {
    mbps: round(throughputFromTimeline(samples), 2),
    bytes: state.bytes,
    capped: state.capped,
  };
}

// Which Cloudflare edge served the test. Useful for spotting the case where a
// roam between APs also moved you to a different POP, which shifts the baseline
// independently of signal strength.
function fetchMeta(ep, agent, signal) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = transportFor(ep.meta).request(ep.meta, { agent, signal }, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const meta = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ colo: meta.colo, city: meta.city });
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => req.destroy());
    req.end();
  });
}

/**
 * Run one full test.
 *
 * Resolves with a result object even when the network is down: a failed test at
 * a known position is the single most valuable data point in a survey, so it is
 * recorded as a zero rather than thrown away.
 */
async function runTest({
  profileName = 'standard', signal, onProgress, includeMeta = false,
  endpoints = null, maxMbPerTest = DEFAULT_MAX_MB_PER_TEST,
} = {}) {
  const profile = PROFILES[profileName] || PROFILES.standard;
  const ep = resolveEndpoints(endpoints);
  const budget = Number(maxMbPerTest) > 0 ? Number(maxMbPerTest) * 1024 * 1024 : 0;
  const downloadCap = budget ? Math.floor(budget * DOWNLOAD_BUDGET_SHARE) : 0;
  const uploadCap = budget ? Math.floor(budget * (1 - DOWNLOAD_BUDGET_SHARE)) : 0;
  const startedAt = new Date().toISOString();
  const t0 = nowMs();
  const abort = signal || new AbortController().signal;

  const result = {
    profile: profileName,
    startedAt,
    downloadMbps: null,
    uploadMbps: null,
    latencyMs: null,
    minLatencyMs: null,
    jitterMs: null,
    bytesUsed: 0,
    durationMs: null,
    capped: false,
    status: 'ok',
    error: null,
    meta: null,
  };

  // A fresh agent per test: pooled sockets from a previous position would carry
  // a warm congestion window that no longer reflects where you are standing.
  const agent = agentFor(profile.connections, ep.download);

  try {
    if (onProgress) onProgress({ phase: 'latency', progress: 0 });
    const latency = await measureLatency(profile, ep, agent, abort);
    Object.assign(result, {
      latencyMs: latency.latencyMs,
      minLatencyMs: latency.minLatencyMs,
      jitterMs: latency.jitterMs,
    });

    if (abort.aborted) throw new Error('cancelled');

    const down = await measureDownload(
      profile, ep, agentFor(profile.connections, ep.download), abort, onProgress, downloadCap,
    );
    result.downloadMbps = down.mbps;
    result.bytesUsed += down.bytes;
    if (down.capped) result.capped = true;

    if (abort.aborted) throw new Error('cancelled');

    const up = await measureUpload(
      profile, ep, agentFor(profile.connections, ep.upload), abort, onProgress, uploadCap,
    );
    result.uploadMbps = up.mbps;
    result.bytesUsed += up.bytes;
    if (up.capped) result.capped = true;

    if (includeMeta) result.meta = await fetchMeta(ep, agentFor(1, ep.meta), abort);
  } catch (err) {
    if (abort.aborted || /cancelled/i.test(err.message)) {
      result.status = 'cancelled';
      result.error = 'Cancelled';
    } else {
      result.status = 'failed';
      result.error = err.message || String(err);
      // Keep whatever landed before the failure; a test that got latency but no
      // throughput still tells you something about the spot.
      if (result.downloadMbps === null) result.downloadMbps = 0;
      if (result.uploadMbps === null) result.uploadMbps = 0;
    }
  } finally {
    agent.destroy();
  }

  result.durationMs = Math.round(nowMs() - t0);
  return result;
}

module.exports = { runTest, PROFILES, ENDPOINTS, DEFAULT_MAX_MB_PER_TEST };

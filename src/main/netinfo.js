'use strict';

// Captures which access point you were attached to, per test.
//
// This is the cheapest form of "where am I" the OS will give us, and it is the
// one that actually explains a slow reading: a 12 Mbps result at -78 dBm on the
// far AP is a coverage hole, the same result at -45 dBm is a backhaul problem.
// It is also how you spot sticky-client roaming while walking.
//
// Everything here is best-effort. No sudo, no prompts, no bundled binaries: if
// the platform will not tell us, we return nulls and the survey carries on.

const { execFile } = require('child_process');

const TIMEOUT_MS = 2500;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function emptyInfo() {
  return { ssid: null, bssid: null, rssi: null, noise: null, channel: null, band: null, txRate: null };
}

function bandFromChannel(channel) {
  const ch = Number(channel);
  if (!Number.isFinite(ch)) return null;
  if (ch <= 14) return '2.4 GHz';
  if (ch >= 32 && ch <= 177) return '5 GHz';
  return '6 GHz';
}

// macOS: system_profiler is the one route that still reports RSSI without root
// on current macOS (the old `airport -I` was removed, and `wdutil info`
// redacts the interesting fields unless elevated).
async function macInfo() {
  const info = emptyInfo();
  const out = await run('/usr/sbin/system_profiler', ['-json', '-detailLevel', 'basic', 'SPAirPortDataType']);
  if (!out) return info;

  try {
    const parsed = JSON.parse(out);
    const interfaces = parsed.SPAirPortDataType?.[0]?.spairport_airport_interfaces || [];
    for (const iface of interfaces) {
      const current = iface.spairport_current_network_information;
      if (!current) continue;
      const { signal, noise } = parseSignalNoise(current);
      info.ssid = current._name ?? null;
      info.bssid = current.spairport_network_bssid ?? null;
      info.channel = parseChannel(current.spairport_network_channel);
      info.band = bandFromChannel(info.channel) || labelBand(current.spairport_network_channel);
      // macOS has used both a combined "signal / noise" string and a separate
      // signal key across releases; take whichever this machine reports.
      info.rssi = signal ?? numberOrNull(current.spairport_network_signal);
      info.noise = noise;
      info.txRate = numberOrNull(current.spairport_network_rate);
      break;
    }
  } catch {
    return info;
  }
  return info;
}

function parseSignalNoise(current) {
  // Appears as e.g. "-52 dBm / -92 dBm".
  const raw = current.spairport_signal_noise || current.spairport_network_signal_noise;
  if (typeof raw !== 'string') return { signal: null, noise: null };
  const nums = raw.match(/-?\d+/g);
  if (!nums) return { signal: null, noise: null };
  return {
    signal: nums[0] !== undefined ? Number(nums[0]) : null,
    noise: nums[1] !== undefined ? Number(nums[1]) : null,
  };
}

function parseChannel(raw) {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).match(/\d+/);
  return m ? Number(m[0]) : null;
}

function labelBand(raw) {
  if (typeof raw !== 'string') return null;
  if (/6GHz|6 GHz/i.test(raw)) return '6 GHz';
  if (/5GHz|5 GHz/i.test(raw)) return '5 GHz';
  if (/2\.4/i.test(raw)) return '2.4 GHz';
  return null;
}

function numberOrNull(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Windows: netsh is fast and gives us everything except raw dBm. Windows
// reports signal as a 0-100 percentage; the documented mapping back to dBm is
// linear over -100..-50, which is good enough to compare positions.
async function winInfo() {
  const info = emptyInfo();
  const out = await run('netsh', ['wlan', 'show', 'interfaces']);
  if (!out) return info;

  const field = (name) => {
    const m = out.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im'));
    return m ? m[1].trim() : null;
  };

  info.ssid = field('SSID');
  info.bssid = field('BSSID');
  info.channel = numberOrNull(field('Channel'));
  info.band = field('Band') || bandFromChannel(info.channel);
  info.txRate = numberOrNull(field('Receive rate \\(Mbps\\)'));

  const pct = numberOrNull(field('Signal'));
  if (pct !== null) {
    info.signalPercent = pct;
    info.rssi = Math.round(pct / 2 - 100);
  }
  return info;
}

// Linux: only present so the app runs end-to-end on a dev box.
async function linuxInfo() {
  const info = emptyInfo();
  const out = await run('nmcli', ['-t', '-f', 'active,ssid,bssid,signal,chan', 'dev', 'wifi']);
  if (!out) return info;
  for (const line of out.split('\n')) {
    if (!line.startsWith('yes:')) continue;
    // nmcli escapes the colons inside a BSSID as "\:".
    const parts = line.split(/(?<!\\):/).map((p) => p.replace(/\\:/g, ':'));
    info.ssid = parts[1] || null;
    info.bssid = parts[2] || null;
    const pct = numberOrNull(parts[3]);
    if (pct !== null) {
      info.signalPercent = pct;
      info.rssi = Math.round(pct / 2 - 100);
    }
    info.channel = numberOrNull(parts[4]);
    info.band = bandFromChannel(info.channel);
    break;
  }
  return info;
}

async function getNetInfo() {
  try {
    if (process.platform === 'darwin') return await macInfo();
    if (process.platform === 'win32') return await winInfo();
    if (process.platform === 'linux') return await linuxInfo();
  } catch {
    // fall through
  }
  return emptyInfo();
}

module.exports = { getNetInfo };

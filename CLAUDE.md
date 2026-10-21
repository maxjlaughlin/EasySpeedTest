# EasySpeedTest — handoff

**Read this first, and update it before every commit.** Status, known bugs, and
recent changes. Keep it under 750 words — trim old history rather than appending.

## Status: v1.0 — working, all tests green

Electron desktop app. Hotkey-driven Wi-Fi speed surveying with floor-plan
mapping. macOS primary, Windows supported by construction (no platform forks
except `netinfo.js`). `npm install && npm start`.

## Layout

| Path | Role |
|---|---|
| `src/main/main.js` | Window, global hotkeys, IPC, keep-awake, smoke hook |
| `src/main/speedtest.js` | Measurement engine. No Electron dep — testable in plain Node |
| `src/main/netinfo.js` | Per-OS Wi-Fi SSID/BSSID/RSSI. Best-effort, never throws |
| `src/main/store.js` | Atomic JSON persistence in userData |
| `src/preload/preload.js` | The only renderer↔main surface (contextIsolation on) |
| `src/renderer/palette.js` | Color ramp + bin thresholds |
| `src/renderer/map.js` | Canvas: pan/zoom, pins, route, path assignment |
| `src/renderer/app.js` | State, UI wiring, exports |

## Design decisions (don't undo without reason)

- **Time-boxed, not size-boxed.** Fixed duration costs the same wall-clock
  everywhere; fixed size takes 40s on bad Wi-Fi. First 25% of each window is
  discarded for TCP slow-start.
- **Sequential one-hue ramp, not red→green.** Status red vs green measure ΔE 4.1
  under deuteranopia — indistinguishable. Below-threshold is encoded separately
  and redundantly (red ring + ✕ glyph + the number).
- **Failed test ⇒ recorded at 0 Mbps, not discarded.** A dead zone is the point
  of the survey.
- **Positions stored normalized (u,v ∈ 0..1).** Survives zoom, resize, and
  re-scanning the plan.
- **Fresh HTTP agent per test.** A pooled socket carries a warm congestion
  window from the previous position.
- **Data cap (default 300 MB/test).** Without it, 50 tests on gigabit ≈ 30 GB.

## Gotchas already hit — don't re-introduce

1. **`window.prompt` does not exist in Electron.** Use `askNumber()` in
   `app.js` (the `<dialog id="ask-dialog">`). `confirm`/`alert` do work.
2. **`[hidden]` loses to any class that sets `display`.** `styles.css` has a
   global `[hidden] { display: none !important }`. Keep it.
3. **`File.path` was removed in Electron 32.** Dropped files go through
   `webUtils.getPathForFile` in the preload.
4. **macOS `airport -I` is gone.** `system_profiler SPAirPortDataType -json` is
   the only no-sudo route to RSSI. Slow (~1-2s), so it runs concurrently with
   the test, never serially.

## Tests

```bash
node scripts/engine-verify.js   # accuracy vs a known-rate local server
npm run smoke                   # drives the real UI (xvfb-run -a on headless)
```

Last run: engine **all passed** — 0.1–0.6% error vs ground truth across
25/80/205 Mbps; cancellation, dead-zone and cap paths covered. UI **31/31**.

The smoke test uses `window.__test`, exposed in `app.js` only when
`api.smoke` is true (set from `EST_SMOKE`). Keep that gate.

## Known limitations (not bugs)

- Upload figures over loopback read in the Gbps — that is the loopback, not an
  error. Real-network accuracy is only verified for download.
- `endpoints` (LAN test target) has no UI control yet — `settings.json` only.
- Hotkeys are only editable in `settings.json`; no UI picker.
- No icon set; builds use the Electron default.
- `npm audit` reports 18 advisories, all inside `electron-builder` dev tooling.
  `npm audit --omit=dev` is clean. No runtime dependencies at all.
- Path assignment assumes an even walking pace between the points you click.
- Windows RSSI is derived from the signal percentage (`pct/2 - 100`), so it is
  coarser than the macOS value.

## Next candidates

1. Settings UI for hotkeys and LAN endpoints.
2. Multi-floor support (plan per floor, floor switcher).
3. Interpolated coverage heatmap between points.
4. App icons + signed/notarized macOS build.
5. Re-run a saved route to compare before/after an AP change.

## Conventions

- Version `MAJOR.MINOR`: major = features, minor = fixes. Shown in the title bar
  and top-left; tagged `vX.Y` on GitHub. `package.json` keeps a third component
  only because npm demands it — bump the first two.
- Push to `main`.
- No runtime dependencies. Keep it that way; it is why the local build is fast.

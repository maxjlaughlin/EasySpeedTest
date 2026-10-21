# EasySpeedTest

**v1.0** — hotkey-driven Wi-Fi speed surveying for walking a building.

Press a hotkey, walk a few feet, press it again. Each reading lands on a floor
plan so you can see where the coverage actually falls apart.

Built for macOS first, cross-platform by construction: Electron plus
`globalShortcut`, so the Windows build needs no redesign.

---

## Install and run

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/maxjlaughlin/EasySpeedTest.git
cd EasySpeedTest
npm install
npm start
```

To build a double-clickable app:

```bash
npm run dist:mac     # .dmg  (arm64 + x64)
npm run dist:win     # .exe installer
```

Builds land in `dist/`. Build on the OS you are targeting — a macOS build needs
a Mac. Unsigned builds will warn on first launch; right-click → Open on macOS.

---

## Hotkeys

These are **global**: they work while the window is behind everything else, so
you can walk with the laptop half-closed.

| Action | macOS | Windows |
|---|---|---|
| Run a test here | `⌘⇧T` | `Ctrl+Shift+T` |
| Next stop / step forward | `⌘⇧N` | `Ctrl+Shift+N` |
| Previous stop / step back | `⌘⇧B` | `Ctrl+Shift+B` |
| Undo the last reading | `⌘⇧Z` | `Ctrl+Shift+Z` |

If another app already owns a combination, the app says so on launch. Change
them in `settings.json` (see **Where data lives**).

---

## Tracking where you are

Three ways, pick per walk. All of them write to the same map.

**Walk & place later** — the lowest-effort option. Just walk and hit the
hotkey; readings queue up with no position. When you are done, click along the
route you walked and the app spreads the readings evenly along that line. Walk
at a roughly even pace and this is accurate enough to find a dead zone.

**Route** — plot your stops on the plan once, then each hotkey press tests at
the current stop and advances to the next. Best for a survey you repeat.

**Free pin** — click or arrow-key a crosshair. Move it twice and the app learns
your walk vector, so every later press steps the same direction and distance
automatically.

A floor plan is optional — drag in a PNG/JPG, even a phone photo of the
fire-escape map. Without one, readings land on a plain grid. **Set scale** turns
pixels into feet: click two points you know the real distance between.

---

## Reading the map

Dot color is download speed on a single-hue ramp — light is slow, dark is fast
(inverted in dark mode so faster always means more contrast).

A **red ring** means the reading is below your "Flag below" threshold, and a
**red ✕** means the test could not reach the network at all. A dead spot is
recorded as a real data point at 0 Mbps, which is usually the whole reason you
are walking around in the first place.

Speed is never shown by color alone: every pin carries its number, and the
table lists all of them. That is deliberate — the usual red/green coverage
heatmap is unreadable for roughly 1 in 12 men, because red and green sit about
ΔE 4 apart under deuteranopia.

---

## Data use

A time-boxed test on a fast link moves a lot of data. **Data cap** (default
300 MB/test) stops each test early once it has moved that much; the reading
stays valid, just measured over a shorter window, and is marked "hit data cap".
The top bar totals the session so far. On a hotspot, drop the cap to ~50 MB and
use the Blitz profile.

By default tests run against Cloudflare's public endpoints, so they measure
Wi-Fi *plus* your internet uplink. To measure the Wi-Fi alone, point the app at
a server on the same LAN — set `endpoints` in `settings.json`:

```json
"endpoints": {
  "download": "http://192.168.1.10:8080/__down",
  "upload":   "http://192.168.1.10:8080/__up",
  "meta":     "http://192.168.1.10:8080/meta"
}
```

---

## Exports

- **CSV** — one row per reading: speeds, latency, jitter, plan coordinates, feet
  (if calibrated), SSID/BSSID/RSSI/channel, and the error for failed tests.
- **JSON** — the whole session, re-loadable and diffable.
- **Map PNG** — the annotated plan as you see it, for dropping into a report.

---

## Where data lives

Surveys and settings are saved automatically (atomically, so a crash mid-walk
costs nothing):

- macOS — `~/Library/Application Support/EasySpeedTest/`
- Windows — `%APPDATA%\EasySpeedTest\`

`session.json` is the current survey, `settings.json` your preferences, and
`floorplans/` holds imported images.

---

## Tests

```bash
node scripts/engine-verify.js   # measurement accuracy vs a known-rate server
npm run smoke                   # drives the real UI headlessly
```

On a headless machine, run the smoke test under `xvfb-run -a npm run smoke`.

---

## Versioning

`MAJOR.MINOR` — major for feature work, minor for fixes and small changes. The
version shows in the title bar and the top-left of the window, and each release
is tagged `vX.Y` on GitHub. `package.json` carries a third component only
because npm requires it.

## License

MIT

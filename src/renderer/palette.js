'use strict';

// Color for the map.
//
// Download speed is a continuous magnitude, so it gets a SEQUENTIAL single-hue
// ramp (blue, light to dark) rather than a red-to-green gradient. That is not a
// style preference: the usual red/green survey heatmap fails colorblind
// separation badly — the status red and status green in this palette measure
// ΔE 4.1 under deuteranopia, which is indistinguishable. A one-hue ramp orders
// by lightness, so it survives any form of color vision deficiency and
// grayscale printing.
//
// Failing the user's own threshold is a STATE, not a magnitude, so it is
// encoded separately and redundantly: a critical-colored ring, a thicker
// stroke, and the number itself. Color never carries that meaning alone.
//
// Ramp steps and status values come from the validated reference palette.

(function () {
  const RAMP_LIGHT = [
    '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec',
    '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab',
    '#184f95', '#104281', '#0d366b',
  ];

  const SURFACES = { light: '#fcfcfb', dark: '#1a1a19' };

  const STATUS = {
    good: '#0ca30c',
    warning: '#fab219',
    serious: '#ec835a',
    critical: '#d03b3b',
  };

  const INK = {
    light: { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9' },
    dark: { primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a' },
  };

  function isDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // Seven bins anchored on the user's pass threshold, so the colors mean the
  // same thing for a 50 Mbps office and a 500 Mbps lab, and — crucially — a
  // pin's color never shifts as later tests come in.
  function bins(threshold) {
    const t = Math.max(1, Number(threshold) || 50);
    return [
      { max: t * 0.25, label: `< ${fmt(t * 0.25)}` },
      { max: t * 0.5, label: `${fmt(t * 0.25)}–${fmt(t * 0.5)}` },
      { max: t, label: `${fmt(t * 0.5)}–${fmt(t)}` },
      { max: t * 2, label: `${fmt(t)}–${fmt(t * 2)}` },
      { max: t * 4, label: `${fmt(t * 2)}–${fmt(t * 4)}` },
      { max: t * 8, label: `${fmt(t * 4)}–${fmt(t * 8)}` },
      { max: Infinity, label: `${fmt(t * 8)}+` },
    ];
  }

  function fmt(n) {
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return String(Math.round(n));
    return String(Math.round(n * 10) / 10);
  }

  // Light surface: value rises light -> dark. Dark surface: the ramp is
  // re-stepped so value rises dark -> light, keeping "more speed = more
  // contrast against the surface" true in both modes. The dark end is clamped
  // at step 600 so the lowest bin is still visible on near-black.
  function rampForMode(dark) {
    if (!dark) {
      return [
        RAMP_LIGHT[1], RAMP_LIGHT[3], RAMP_LIGHT[5],
        RAMP_LIGHT[7], RAMP_LIGHT[9], RAMP_LIGHT[10], RAMP_LIGHT[12],
      ];
    }
    return [
      RAMP_LIGHT[10], RAMP_LIGHT[9], RAMP_LIGHT[7],
      RAMP_LIGHT[5], RAMP_LIGHT[3], RAMP_LIGHT[1], RAMP_LIGHT[0],
    ];
  }

  function binIndex(mbps, threshold) {
    const b = bins(threshold);
    const v = Number(mbps) || 0;
    for (let i = 0; i < b.length; i++) if (v < b[i].max) return i;
    return b.length - 1;
  }

  function colorFor(mbps, threshold) {
    const dark = isDark();
    return rampForMode(dark)[binIndex(mbps, threshold)];
  }

  function legendItems(threshold) {
    const dark = isDark();
    const ramp = rampForMode(dark);
    return bins(threshold).map((b, i) => ({ color: ramp[i], label: b.label }));
  }

  window.Palette = {
    colorFor,
    legendItems,
    binIndex,
    isDark,
    status: STATUS,
    ink: () => (isDark() ? INK.dark : INK.light),
    surface: () => (isDark() ? SURFACES.dark : SURFACES.light),
  };
})();

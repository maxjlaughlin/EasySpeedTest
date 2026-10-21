'use strict';

// Headless UI smoke test.
//
// Launches the real app, drives the renderer through the placement flows with a
// scenario script, and fails on any renderer console error. Needs a display;
// on a headless box run it under xvfb-run:
//
//   xvfb-run -a npm run smoke
//
// The screenshot it leaves behind is the quickest way to eyeball a layout
// regression.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const electron = require(path.join(root, 'node_modules', 'electron'));

const outDir = process.env.EST_SMOKE_DIR || path.join(os.tmpdir(), 'easyspeedtest-smoke');
fs.mkdirSync(outDir, { recursive: true });
const shot = path.join(outDir, 'smoke.png');
const scenario = path.join(__dirname, 'smoke-scenario.js');

// A scratch profile keeps the test off the real survey in userData.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'est-profile-'));

const child = spawn(electron, [root, '--no-sandbox', `--user-data-dir=${userData}`], {
  env: { ...process.env, EST_SMOKE: shot, EST_SMOKE_SCENARIO: scenario },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', () => {});

const timer = setTimeout(() => {
  console.error('smoke: timed out after 60s');
  child.kill('SIGKILL');
  process.exitCode = 1;
}, 60000);

child.on('exit', (code) => {
  clearTimeout(timer);

  const reportLine = stdout.split('\n').find((l) => l.startsWith('SMOKE_REPORT '));
  const errorLine = stdout.split('\n').find((l) => l.startsWith('SMOKE_ERRORS '));

  let failures = 0;
  if (reportLine) {
    const report = JSON.parse(reportLine.slice('SMOKE_REPORT '.length));
    for (const check of report.checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? `  (${check.detail})` : ''}`);
      if (!check.ok) failures++;
    }
  } else {
    console.error('smoke: renderer produced no report');
    failures++;
  }

  if (errorLine) {
    const errors = JSON.parse(errorLine.slice('SMOKE_ERRORS '.length));
    for (const e of errors) {
      console.error(`FAIL  renderer console error: ${e}`);
      failures++;
    }
  }

  if (fs.existsSync(shot)) console.log(`\nscreenshot: ${shot}`);
  console.log(failures === 0 ? '\nALL UI CHECKS PASSED' : `\n${failures} UI CHECK(S) FAILED`);
  process.exitCode = failures === 0 && code === 0 ? 0 : 1;
});

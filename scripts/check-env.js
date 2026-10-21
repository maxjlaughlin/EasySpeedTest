'use strict';

// Runs after `npm install`. Its only job is to fail loudly and early with a
// readable message, rather than letting Electron die with a cryptic error the
// first time someone runs `npm start` on an old Node.

const MIN_NODE_MAJOR = 18;

const major = Number(process.versions.node.split('.')[0]);

if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
  console.error(
    `\n  EasySpeedTest needs Node ${MIN_NODE_MAJOR} or newer (found ${process.versions.node}).\n`
    + '  Install a current Node from https://nodejs.org and run npm install again.\n',
  );
  process.exitCode = 1;
} else {
  console.log(`\n  EasySpeedTest ready. Run "npm start".\n`);
}

'use strict';

const { spawnSync } = require('child_process');
const { readdirSync } = require('fs');
const { join } = require('path');

const spawnOpts = {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
};
for (const filename of readdirSync(__dirname)) {
  if (!/^test-.+[.]js$/i.test(filename))
    continue;
  const spawnArgs = [join(__dirname, filename)];
  const { status: exitCode, signal } =
    spawnSync(process.execPath, spawnArgs, spawnOpts);
  if (exitCode !== 0) {
    console.error(
      `${filename} failed with exit code ${exitCode}, signal ${signal}`
    );
  }
}

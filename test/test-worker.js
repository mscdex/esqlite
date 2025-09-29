'use strict';

let Worker;
let isMainThread;

try {
  ({ Worker, isMainThread } = require('worker_threads'));
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND')
    throw e;
  process.exit(0);
}

require('../lib/index.js');

if (isMainThread) {
  async function runWorker() {
    return new Promise((r) => new Worker(__filename).on('exit', r));
  }
  runWorker()
    .then(runWorker)
    .then(runWorker)
    .then(runWorker);
}

'use strict';

function once(fn) {
  if (typeof fn !== 'function')
    throw new TypeError('Missing function');
  return (...args) => {
    if (!fn)
      return;
    const fn_ = fn;
    fn = undefined;
    fn_(...args);
  };
}

function test(fn) {
  const line = (new Error()).stack.split('\n')[2].split(':').reverse()[1];
  const promise = fn();
  promise.line = line;
  promise.then(() => {
    promise.resolved = true;
  }, (err) => {
    promise.errored = err;
  });
  test.tests.push(promise);
}
test.tests = [];

process.once('exit', () => {
  const errored = test.tests.filter((p) => !!p.errored);
  const unfinished = test.tests.filter((p) => (!p.resolved && !p.errored));
  if (errored.length) {
    console.error('The following tests failed');
    console.error('==========================');
    const indent = '    ';
    for (const promise of errored) {
      console.error(`  * Test on line #${promise.line}:`);
      console.error(
        indent + promise.errored.stack.replace(/\n(?!$)/g, `\n${indent}`)
      );
    }
  }
  if (unfinished.length) {
    if (errored.length)
      console.error('');
    console.error('The following tests did not finish');
    console.error('==================================');
    for (const promise of unfinished)
      console.error(`  * Test on line #${promise.line}`);
  }
  if (errored.length || unfinished.length)
    process.exitCode = 1;
});

module.exports = {
  once,
  test,
};

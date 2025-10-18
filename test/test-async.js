'use strict';

const assert = require('assert');
const { join } = require('path');

const { Database, OPEN_FLAGS } = require(join(__dirname, '..', 'lib'));
const { test } = require(join(__dirname, 'common.js'));

let supportsAsyncDispose = false;
{
  const AsyncFunction = (async () => {}).constructor;
  try {
    new AsyncFunction('const foo = {}; { await using bar = foo; }');
    supportsAsyncDispose = true;
  } catch (ex) {
    if (ex.name !== 'SyntaxError')
      throw ex;
  }
}

if (!Promise.allSettled) {
  // Polyfill for node pre-v12.9.0
  Promise.allSettled = async (iterable) => {
    const results = [];
    for (const promise of iterable) {
      try {
        const value = await promise;
        results.push({ status: 'fulfilled', value });
      } catch (reason) {
        results.push({ status: 'rejected', reason });
      }
    }
    return results;
	};
}

// =============================================================================

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const stmt = db.queryAsync('SELECT * FROM generate_series(10,100,10)');
  const stmt2 = db.queryAsync('SELECT * FROM generate_series(10,100,5)');
  await stmt.execute(1);
  stmt2.abort();
  while (await stmt.execute(1));
  await assert.rejects(stmt2.execute(), /aborted/);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const stmt = db.queryAsync('-- foo bar baz');
  const promises = [
    stmt.execute(),
    stmt.execute(),
  ];
  assert.deepStrictEqual(await Promise.allSettled(promises), [
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const stmt = db.queryAsync('SELECT * FROM generate_series(1,10,2)');
  for await (const rows of stmt)
    results.push(rows);
  assert.deepStrictEqual(results, [
    [ { value: '1' } ],
    [ { value: '3' } ],
    [ { value: '5' } ],
    [ { value: '7' } ],
    [ { value: '9' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const stmt = db.queryAsync('SELECT * FROM generate_series(1,10,2)');
  let i = 0;
  for await (const rows of stmt) {
    results.push(rows);
    if (++i === 3)
      break;
  }
  assert.deepStrictEqual(results, [
    [ { value: '1' } ],
    [ { value: '3' } ],
    [ { value: '5' } ],
  ]);
  await assert.rejects(stmt.execute(), /aborted/);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const stmt = db.queryAsync('SELECT * FROM generate_series(1,10,2)');
  for await (const rows of stmt.iterate(2))
    results.push(rows);
  assert.deepStrictEqual(results, [
    [ { value: '1' }, { value: '3' } ],
    [ { value: '5' }, { value: '7' } ],
    [ { value: '9' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const stmt = db.queryAsync('SELECT * FROM generate_series(1,10,2)');
  let i = 0;
  for await (const rows of stmt.iterate(2)) {
    results.push(rows);
    if (++i === 2)
      break;
  }
  assert.deepStrictEqual(results, [
    [ { value: '1' }, { value: '3' } ],
    [ { value: '5' }, { value: '7' } ],
  ]);
  await assert.rejects(stmt.execute(), /aborted/);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const iter = db.queryMultiAsync([
    'SELECT * FROM generate_series(10,100,10)',
    'SELECT * FROM generate_series(1,10,2)',
  ].join(';'));
  for await (const stmt of iter) {
    let rows;
    while (rows = await stmt.execute(1))
      results.push(rows);
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' } ],
    [ { value: '20' } ],
    [ { value: '30' } ],
    [ { value: '40' } ],
    [ { value: '50' } ],
    [ { value: '60' } ],
    [ { value: '70' } ],
    [ { value: '80' } ],
    [ { value: '90' } ],
    [ { value: '100' } ],
    [ { value: '1' } ],
    [ { value: '3' } ],
    [ { value: '5' } ],
    [ { value: '7' } ],
    [ { value: '9' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const iter = db.queryMultiAsync([
    'SELECT * FROM generate_series(10,100,10)',
    'SELECT * FROM generate_series(1,10,2)',
  ].join(';'));
  let i = 0;
  for await (const stmt of iter) {
    if (i++ === 0) {
      results.push(await stmt.execute(3));
      continue;
    }
    let rows;
    while (rows = await stmt.execute(1))
      results.push(rows);
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' }, { value: '20' }, { value: '30' } ],
    [ { value: '1' } ],
    [ { value: '3' } ],
    [ { value: '5' } ],
    [ { value: '7' } ],
    [ { value: '9' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const iter = db.queryMultiAsync([
    'SELECT * FROM generate_series(10,100,10)',
    'SELECT * FROM generate_series(1,10,2)',
  ].join(';'));
  for await (const stmt of iter) {
    results.push(await stmt.execute(1));
    break;
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' } ],
  ]);
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const stmt of iter);
  }, /aborted/);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const iter = db.queryMultiAsync([
    'SELECT * FROM generate_series(10,100,10)',
    'SELECT * FROM generate_series(1,10,2)',
  ].join(';'));
  for await (const stmt of iter) {
    results.push(await stmt.execute(1));
    break;
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' } ],
  ]);
  await iter.abort();
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const iter1 = db.queryMultiAsync('SELECT * FROM generate_series(10,100,10)');
  const iter2 = db.queryMultiAsync('SELECT * FROM generate_series(1,10,2)');
  const iter3 = db.queryMultiAsync('SELECT * FROM generate_series(2,10,2)');
  await iter2.abort();
  for await (const stmt of iter1) {
    results.push(await stmt.execute());
    break;
  }
  for await (const stmt of iter3) {
    results.push(await stmt.execute());
    break;
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' },
      { value: '20' },
      { value: '30' },
      { value: '40' },
      { value: '50' },
      { value: '60' },
      { value: '70' },
      { value: '80' },
      { value: '90' },
      { value: '100' } ],
    [ { value: '2' },
      { value: '4' },
      { value: '6' },
      { value: '8' },
      { value: '10' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const iter = db.queryMultiAsync([
    'SELECT * FROM generate_series(10,100,10)',
    'SELECT * FROM generate_series(1,10,2)',
  ].join(';'));
  // eslint-disable-next-line no-unused-vars
  for await (const stmt of iter)
    break;
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const stmt of iter)
      assert.fail('Should not get here');
  }, /aborted/);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const iter = db.queryMultiAsync([
    'SELECT * FROM generate_series(10,100,10)',
    'SELECT * FROM generate_series(1,10,2)',
  ].join(';'), { abortAllOnBreak: false });
  for await (const stmt of iter) {
    results.push(await stmt.execute(1));
    break;
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' } ],
  ]);
  for await (const stmt of iter) {
    let rows;
    while (rows = await stmt.execute(1))
      results.push(rows);
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' } ],
    [ { value: '20' } ],
    [ { value: '30' } ],
    [ { value: '40' } ],
    [ { value: '50' } ],
    [ { value: '60' } ],
    [ { value: '70' } ],
    [ { value: '80' } ],
    [ { value: '90' } ],
    [ { value: '100' } ],
    [ { value: '1' } ],
    [ { value: '3' } ],
    [ { value: '5' } ],
    [ { value: '7' } ],
    [ { value: '9' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  const iter = db.queryMultiAsync([
    'SELECT * FROM generate_series(10,100,10)',
    'SELECT * FROM generate_series(1,10,2)',
  ].join(';'), { abortAllOnBreak: false, abortOnBreak: true });
  for await (const stmt of iter) {
    results.push(await stmt.execute(1));
    break;
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' } ],
  ]);
  for await (const stmt of iter) {
    let rows;
    while (rows = await stmt.execute(1))
      results.push(rows);
  }
  assert.deepStrictEqual(results, [
    [ { value: '10' } ],
    [ { value: '1' } ],
    [ { value: '3' } ],
    [ { value: '5' } ],
    [ { value: '7' } ],
    [ { value: '9' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open(OPEN_FLAGS.READONLY);
  const stmt = db.queryAsync('CREATE TABLE foo (id INTEGER)');
  await assert.rejects(stmt.execute(), { code: 'SQLITE_READONLY' });
  db.close();
});

test(async () => {
  const db = new Database(':memory:', () => false);
  db.open();
  const stmt = db.queryAsync('SELECT 1');
  await assert.rejects(stmt.execute(), { code: 'SQLITE_AUTH' });
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const results = [];
  db.query('SELECT 1 a', (err, rows) => {
    results.push(rows);
  });
  results.push(await db.queryAsync('SELECT 2 b').execute());
  assert.deepStrictEqual(results, [
    [ { a: '1' } ],
    [ { b: '2' } ],
  ]);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const stmt = db.queryAsync('SELECT 1 a');
  assert.deepStrictEqual(await stmt.execute(), [ { a: '1' } ]);
  await stmt.abort();
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const stmt = db.queryAsync('SELECT 1 a');
  assert.deepStrictEqual(await stmt.execute(), [ { a: '1' } ]);
  assert.strictEqual(await stmt.execute(), undefined);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const stmt = db.queryAsync('SELECT 1 a');
  const errMatch = /invalid row count value/i;
  await assert.rejects(async () => stmt.execute(true), errMatch);
  await assert.rejects(async () => stmt.execute(Infinity), errMatch);
  await assert.rejects(async () => stmt.execute(-1), errMatch);
  await assert.rejects(async () => stmt.execute(0), errMatch);
  await assert.rejects(async () => stmt.execute(4.2), errMatch);
  await assert.rejects(async () => stmt.execute(10n), errMatch);
  await assert.rejects(
    async () => stmt.execute(Number.MAX_SAFE_INTEGER),
    errMatch
  );
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const stmt = db.queryAsync('SELECT * FROM generate_series(1,10,2)');
  const first = stmt.execute(1);
  const rejections = [
    assert.rejects(stmt.execute(1), /aborted/),
    assert.rejects(stmt.execute(1), /aborted/),
  ];
  const aborting = stmt.abort();
  assert.deepStrictEqual(await first, [ { value: '1' } ]);
  await Promise.all(rejections);
  await aborting;
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  const iter = db.queryMultiAsync('-- foo bar baz');
  assert.strictEqual(await (await iter.next()).value.execute(), undefined);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open(OPEN_FLAGS.READONLY);
  const iter = db.queryMultiAsync('CREATE TABLE foo (id INTEGER)');
  await assert.rejects(
    (await iter.next()).value.execute(),
    { code: 'SQLITE_READONLY' }
  );
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  assert.deepStrictEqual(
    await (
      await db.queryMultiAsync('SELECT ? a', [ 5 ]).next()
    ).value.execute(),
    [ { a: '5' } ]
  );
  assert.deepStrictEqual(
    await (
      await db.queryMultiAsync('SELECT ? b', { values: [ 6 ] }).next()
    ).value.execute(),
    [ { b: '6' } ]
  );
  assert.deepStrictEqual(
    await (
      await db.queryMultiAsync('SELECT :num c', { values: { num: 7 } }).next()
    ).value.execute(),
    [ { c: '7' } ]
  );
  assert.throws(
    () => db.queryMultiAsync('SELECT 8 d', { values: true }),
    /invalid/i
  );
  await assert.rejects(
    (
      await db.queryMultiAsync('SELECT ? e', { values: [ {} ] }).next()
    ).value.execute(),
    /unsupported value/i
  );
  assert.throws(() => db.queryMultiAsync(true), /invalid/i);
  assert.throws(() => db.queryMultiAsync({}), /invalid/i);
  assert.throws(() => db.queryMultiAsync(1), /invalid/i);
  db.close();
});

test(async () => {
  const db = new Database(':memory:');
  db.open();
  assert.deepStrictEqual(
    await db.queryAsync('SELECT ? a', [ 5 ]).execute(),
    [ { a: '5' } ]
  );
  assert.deepStrictEqual(
    await db.queryAsync('SELECT ? b', { values: [ 6 ] }).execute(),
    [ { b: '6' } ]
  );
  assert.deepStrictEqual(
    await db.queryAsync('SELECT :num c', { values: { num: 7 } }).execute(),
    [ { c: '7' } ]
  );
  assert.throws(
    () => db.queryAsync('SELECT 8 d', { values: true }),
    /invalid/i
  );
  await assert.rejects(
    db.queryAsync('SELECT ? e', { values: [ {} ] }).execute(),
    /unsupported value/i
  );
  {
    const query1 = db.queryAsync('SELECT 10 e').execute();
    const query2 = db.queryAsync('SELECT ? f', { values: [ {} ] }).execute();
    await query1;
    await assert.rejects(query2, /unsupported value/i);
  }
  assert.throws(() => db.queryAsync(true), /invalid/i);
  assert.throws(() => db.queryAsync({}), /invalid/i);
  assert.throws(() => db.queryAsync(1), /invalid/i);
  db.close();
});

if (supportsAsyncDispose) {
  test(new Function('assert,Database', `
    return async () => {
      const db = new Database(':memory:');
      db.open();
      const results = [];
      {
        await using iter1 = db.queryMultiAsync([
          'SELECT * FROM generate_series(10,100,10)',
          'SELECT * FROM generate_series(1,10,2)',
        ].join(';'));
        results.push(await (await iter1.next()).value.execute(1));
      }
      assert.deepStrictEqual(results, [ [ { value: '10' } ] ]);

      const iter2 =
        db.queryMultiAsync('SELECT * FROM generate_series(2,10,2)');
      for await (const stmt of iter2)
        results.push(await stmt.execute());
      assert.deepStrictEqual(results, [
        [ { value: '10' } ],
        [ { value: '2' },
          { value: '4' },
          { value: '6' },
          { value: '8' },
          { value: '10' } ],
      ]);
      db.close();
    };
  `)(assert, Database));
  test(new Function('assert,Database', `
    return async () => {
      const db = new Database(':memory:');
      db.open();
      const results = [];
      {
        await using stmt1 = db.queryAsync(
          'SELECT * FROM generate_series(10,100,10)',
        );
        results.push(await stmt1.execute(1));
      }
      assert.deepStrictEqual(results, [ [ { value: '10' } ] ]);

      const stmt2 = db.queryAsync('SELECT * FROM generate_series(2,10,2)');
      results.push(await stmt2.execute());
      assert.deepStrictEqual(results, [
        [ { value: '10' } ],
        [ { value: '2' },
          { value: '4' },
          { value: '6' },
          { value: '8' },
          { value: '10' } ],
      ]);
      db.close();
    };
  `)(assert, Database));
} else {
  console.log('Skipped asyncDispose tests');
}

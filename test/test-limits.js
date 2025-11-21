'use strict';

const assert = require('assert');

const { Database, LIMITS } = require('..');
const { test } = require('./common.js');

test(async () => {
  const db = new Database(':memory:');
  db.open();

  assert.throws(() => db.limit(1024), /invalid limit type/i);
  assert.throws(() => db.limit(null), /invalid limit type/i);
  assert.throws(() => db.limit(true), /invalid limit type/i);
  assert.throws(() => db.limit(LIMITS.ATTACHED, null), /invalid new limit/i);
  assert.throws(() => db.limit(LIMITS.ATTACHED, true), /invalid new limit/i);
  assert.throws(() => db.limit(LIMITS.ATTACHED, false), /invalid new limit/i);
  assert.throws(() => db.limit(LIMITS.ATTACHED, 2 ** 31), /invalid new limit/i);
  assert.throws(
    () => db.limit(LIMITS.ATTACHED, -(2 ** 32)), /invalid new limit/i
  );

  // Get current value
  assert.strictEqual(db.limit(LIMITS.ATTACHED), 10);
  // Make sure nothing was changed by the previous call to `limit()`
  assert.strictEqual(db.limit(LIMITS.ATTACHED), 10);

  // Make sure -1 makes no changes
  assert.strictEqual(db.limit(LIMITS.ATTACHED, -1), 10);
  // Make sure -1 makes no changes (again)
  assert.strictEqual(db.limit(LIMITS.ATTACHED, -1), 10);

  // Disable ATTACH
  assert.strictEqual(db.limit(LIMITS.ATTACHED, 0), 10);
  const stmt = db.queryAsync(`ATTACH ':memory:' AS db2`);
  await assert.rejects(stmt.execute(), /too many attached databases/i);

  // Re-enable ATTACH
  assert.strictEqual(db.limit(LIMITS.ATTACHED, 1), 0);
  await db.queryAsync(`ATTACH ':memory:' AS db2`).execute();

  db.close();
});

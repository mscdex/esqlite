'use strict';

const assert = require('assert');
const { mkdirSync, rmdirSync, unlinkSync } = require('fs');
const { join } = require('path');

const {
  ACTION_CODES,
  Database,
  version,
} = require(join(__dirname, '..', 'lib'));

const { test } = require(join(__dirname, 'common.js'));

assert(/^[0-9.]+ \/ MC [0-9.]+-[a-f0-9]+$/.test(version));

test(() => new Promise((resolve, reject) => {
  try {
    assert.throws(() => new Database(true), /invalid path/i);
    assert.throws(() => new Database({}), /invalid path/i);
    assert.throws(() => new Database(1), /invalid path/i);
  } catch (ex) {
    return reject(ex);
  }
  resolve();
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    CREATE TABLE data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emailAddress VARCHAR(254),
      firstName VARCHAR(50),
      lastName VARCHAR(50),
      age INT,
      secret BLOB
    )
  `, (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(rows, []);
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
  assert.throws(() => db.close());
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    CREATE TABLE data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emailAddress VARCHAR(254),
      firstName VARCHAR(50),
      lastName VARCHAR(50),
      age INT,
      secret BLOB
    )
  `, () => {});

  const values = [
    'foo@example.org', 'Foo', 'Bar', null, Buffer.from('abcd'),
    'baz@example.com', 'Baz', 'Quux', 66, Buffer.from('efgh'),
    'quuy@example.net', 'Quuy', 'Quuz', 33, Buffer.from('ijkl'),
    'utf8@example.net', 'テスト', 'test', 99, Buffer.from('1'),
  ];
  db.query(`
    INSERT INTO data (emailAddress, firstName, lastName, age, secret)
    VALUES (?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?)
  `, values, (err, rows) => {
    try {
      assert.strictEqual(db.autoCommitEnabled(), true);
      assert.ifError(err);
      assert.deepStrictEqual(rows, []);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    CREATE TABLE data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emailAddress VARCHAR(254),
      firstName VARCHAR(50),
      lastName VARCHAR(50),
      age INT,
      secret BLOB
    )
  `);

  {
    const values = [
      'foo@example.org', 'Foo', 'Bar', null, Buffer.from('abcd'),
      'baz@example.com', 'Baz', 'Quux', 66, Buffer.from('efgh'),
      'quuy@example.net', 'Quuy', 'Quuz', 33, Buffer.from('ijkl'),
      'utf8@example.net', 'テスト', 'test', 99, Buffer.from('1'),
    ];
    db.query(`
      INSERT INTO data (emailAddress, firstName, lastName, age, secret)
      VALUES (?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?)
    `, values);
  }

  const values = { age: 50 };
  db.query('SELECT * FROM data WHERE age < :age', { values }, (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(rows, [{
        id: '3',
        emailAddress: 'quuy@example.net',
        firstName: 'Quuy',
        lastName: 'Quuz',
        age: '33',
        secret: Buffer.from('ijkl'),
      }]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    CREATE TABLE data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emailAddress VARCHAR(254),
      firstName VARCHAR(50),
      lastName VARCHAR(50),
      age INT,
      secret BLOB
    )
  `);

  {
    const values = [
      'foo@example.org', 'Foo', 'Bar', null, Buffer.from('abcd'),
      'baz@example.com', 'Baz', 'Quux', 66, Buffer.from('efgh'),
      'quuy@example.net', 'Quuy', 'Quuz', 33, Buffer.from('ijkl'),
      'utf8@example.net', 'テスト', 'test', 99, Buffer.from('1'),
    ];
    db.query(`
      INSERT INTO data (emailAddress, firstName, lastName, age, secret)
      VALUES (?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?)
    `, values);
  }

  db.query('SELECT * FROM data ORDER BY id', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(rows, [{
        id: '1',
        emailAddress: 'foo@example.org',
        firstName: 'Foo',
        lastName: 'Bar',
        age: null,
        secret: Buffer.from('abcd'),
      }, {
        id: '2',
        emailAddress: 'baz@example.com',
        firstName: 'Baz',
        lastName: 'Quux',
        age: '66',
        secret: Buffer.from('efgh'),
      }, {
        id: '3',
        emailAddress: 'quuy@example.net',
        firstName: 'Quuy',
        lastName: 'Quuz',
        age: '33',
        secret: Buffer.from('ijkl'),
      }, {
        id: '4',
        emailAddress: 'utf8@example.net',
        firstName: 'テスト',
        lastName: 'test',
        age: '99',
        secret: Buffer.from('1'),
      }]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    SELECT 'hello' msg1;
    SELECT 'world' msg2
  `, { single: false }, (err, rows) => {
    try {
      assert.deepStrictEqual(err, [
        null,
        null,
      ]);
      assert.deepStrictEqual(rows, [
        [ { msg1: 'hello' } ],
        [ { msg2: 'world' } ],
      ]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query('THISISNOTVALIDSYNTAX', (err, rows) => {
    try {
      assert(err instanceof Error);
      assert(!rows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    SELECT 'hello' msg;
    THISISNOTVALIDSYNTAX
  `, { single: false }, (err, rows) => {
    try {
      assert(Array.isArray(err));
      assert.strictEqual(err.length, 2);
      assert(!err[0]);
      assert(err[1] instanceof Error);
      assert.deepStrictEqual(rows, [
        [ { msg: 'hello' } ],
        undefined,
      ]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    SELECT msg;
    SELECT msg
  `, { single: false }, (err, rows) => {
    try {
      assert(Array.isArray(err));
      assert.strictEqual(err.length, 2);
      assert(err[0] instanceof Error);
      assert(err[1] instanceof Error);
      assert.deepStrictEqual(rows, [
        undefined,
        undefined,
      ]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query(`
    THISISNOTVALIDSYNTAX;
    SELECT 'hello' msg
  `, { single: false }, (err, rows) => {
    try {
      assert(Array.isArray(err));
      assert.strictEqual(err.length, 2);
      assert(err[0] instanceof Error);
      assert(!err[1]);
      assert.strictEqual(rows.length, 2);
      assert(!rows[0]);
      assert.deepStrictEqual(rows[1], [ { msg: 'hello' } ]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test basic authorizer (allow all)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
    [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
  ];
  const actualAuth = [];
  const expectedRows = [
    { value: '25' }, { value: '50' }, { value: '75' }, { value: '100' },
  ];
  const db = new Database(':memory:', (...args) => {
    actualAuth.push(args);
    return true;
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test basic authorizer (ignore READs)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
    [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
  ];
  const actualAuth = [];
  const expectedRows = [
    { value: null }, { value: null }, { value: null }, { value: null },
  ];
  const db = new Database(':memory:', (...args) => {
    actualAuth.push(args);
    if (args[0] === ACTION_CODES.SELECT)
      return true;
    return null;
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test basic authorizer (ignore all)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
  ];
  const actualAuth = [];
  const expectedRows = [];
  const db = new Database(':memory:', (...args) => {
    actualAuth.push(args);
    return null;
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test basic authorizer (deny all)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
  ];
  const actualAuth = [];
  const db = new Database(':memory:', (...args) => {
    actualAuth.push(args);
    return false;
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert(err instanceof Error);
      assert(!rows);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test advanced authorizer (allow all)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
    [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
  ];
  const actualAuth = [];
  const expectedRows = [
    { value: '25' }, { value: '50' }, { value: '75' }, { value: '100' },
  ];
  const db = new Database(':memory:', {
    callback: (...args) => {
      actualAuth.push(args);
      return true;
    },
    filter: [ ACTION_CODES.SELECT, ACTION_CODES.READ ],
    filterNoMatchResult: false,
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test advanced authorizer (ignore READs)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
    [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
  ];
  const actualAuth = [];
  const expectedRows = [
    { value: null }, { value: null }, { value: null }, { value: null },
  ];
  const db = new Database(':memory:', {
    callback: (...args) => {
      actualAuth.push(args);
      if (args[0] === ACTION_CODES.SELECT)
        return true;
      return null;
    },
    filter: [ ACTION_CODES.SELECT, ACTION_CODES.READ ],
    filterNoMatchResult: false,
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test advanced authorizer (ignore all)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
  ];
  const actualAuth = [];
  const expectedRows = [];
  const db = new Database(':memory:', {
    callback: (...args) => {
      actualAuth.push(args);
      return null;
    },
    filter: [ ACTION_CODES.SELECT, ACTION_CODES.READ ],
    filterNoMatchResult: false,
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test advanced authorizer (deny all)
  const expectedAuth = [
    [ ACTION_CODES.SELECT, null, null, null, null ],
  ];
  const actualAuth = [];
  const db = new Database(':memory:', {
    callback: (...args) => {
      actualAuth.push(args);
      return false;
    },
    filter: [ ACTION_CODES.SELECT, ACTION_CODES.READ ],
    filterNoMatchResult: false,
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert(err instanceof Error);
      assert(!rows);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test advanced authorizer, no cb (allow SELECTs, ignore others)
  const expectedRows = [
    { value: null }, { value: null }, { value: null }, { value: null },
  ];
  const db = new Database(':memory:', {
    filter: [ ACTION_CODES.SELECT ],
    filterMatchResult: true,
    filterNoMatchResult: null,
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test advanced authorizer, no cb (deny all)
  const db = new Database(':memory:', {
    filter: [],
    filterMatchResult: true,
    filterNoMatchResult: false,
  });
  db.open();
  db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
    try {
      assert(err instanceof Error);
      assert(!rows);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  // Test advanced authorizer, no cb, missing filter non-match result
  assert.throws(() => new Database(':memory:', { filter: [] }));
  // Test advanced authorizer, no cb, invalid filters
  assert.throws(() => {
    new Database(':memory:', { filter: {}, filterNoMatchResult: true });
  });
  assert.throws(() => {
    new Database(':memory:', { filter: true, filterNoMatchResult: true });
  });
  assert.throws(() => {
    new Database(':memory:', { filter: false, filterNoMatchResult: true });
  });
  assert.throws(() => {
    new Database(':memory:', { filter: null, filterNoMatchResult: true });
  });
  assert.throws(() => {
    new Database(':memory:', {
      filter: () => {},
      filterNoMatchResult: true,
    });
  });
  // Test advanced authorizer, no cb, invalid filters non-match result
  assert.throws(() => new Database(':memory:', { filterNoMatchResult: 0 }));
  assert.throws(() => {
    new Database(':memory:', { filterNoMatchResult: undefined });
  });
  resolve();
}));

test(() => new Promise((resolve, reject) => {
  const result = [];
  const db = new Database(':memory:');
  db.open();
  db.query(`
    CREATE TABLE data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emailAddress VARCHAR(254),
      firstName VARCHAR(50),
      lastName VARCHAR(50),
      age INT,
      secret BLOB
    )
  `, (err) => {
    try {
      assert.ifError(err);
      result.push(1);
    } catch (ex) {
      return reject(ex);
    }
  });

  {
    const values = [
      'foo@example.org', 'Foo', 'Bar', null, Buffer.from('abcd'),
    ];
    db.query(`
      INSERT INTO data (emailAddress, firstName, lastName, age, secret)
      VALUES (?, ?, ?, ?, ?)
    `, values, (err) => {
      try {
        assert.ifError(err);
        result.push(2);
      } catch (ex) {
        return reject(ex);
      }
    });
  }

  db.query('SELECT * FROM data', (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(rows, [{
        id: '1',
        emailAddress: 'foo@example.org',
        firstName: 'Foo',
        lastName: 'Bar',
        age: null,
        secret: Buffer.from('abcd'),
      }]);
      result.push(3);

      assert.deepStrictEqual(result, [ 1, 2, 3 ]);
      process.nextTick(() => {
        db.query('SELECT * FROM data', (err) => {
          try {
            assert(err instanceof Error);
            assert(/not open/.test(err.message));
          } catch (ex) {
            return reject(ex);
          }
          resolve();
        });
      });
    } catch (ex) {
      return reject(ex);
    }
  });

  db.end();
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  db.query('SELECT 1 a', (err) => {
    try {
      assert.ifError(err);
      process.nextTick(() => {
        db.end();
        db.query('SELECT 2 b', (err) => {
          try {
            assert(err instanceof Error);
            assert(/not open/.test(err.message));
          } catch (ex) {
            return reject(ex);
          }
          resolve();
        });
      });
    } catch (ex) {
      return reject(ex);
    }
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  try {
    assert.throws(() => db.query(true, (err) => {
      assert(false);
    }), /invalid/i);
    assert.throws(() => db.query({}, (err) => {
      assert(false);
    }), /invalid/i);
    assert.throws(() => db.query(1, (err) => {
      assert(false);
    }), /invalid/i);
    db.close();
  } catch (ex) {
    return reject(ex);
  }
  resolve();
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  try {
    assert.throws(() => db.query('SELECT 1 a', { values: true }, (err) => {
      assert(false);
    }), /invalid/i);
    db.close();
  } catch (ex) {
    return reject(ex);
  }
  resolve();
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  const opts = { rowsAsArray: true };
  db.query(`SELECT 100 foo, 'bar' baz`, opts, (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(rows, [ [ '100', 'bar' ] ]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(() => new Promise((resolve, reject) => {
  const db = new Database(':memory:');
  db.open();
  const opts = { rowsAsArray: true };
  db.query(`SELECT decimal_cmp('-4.5', '-10')`, opts, (err, rows) => {
    try {
      assert.ifError(err);
      assert.deepStrictEqual(rows, [ [ '1' ] ]);
      db.close();
    } catch (ex) {
      return reject(ex);
    }
    resolve();
  });
}));

test(async () => {
  const basePath = join(__dirname, 'tmp');
  const dbPath = join(basePath, 'encrypted.db');
  try {
    mkdirSync(basePath);
  } catch (ex) {
    if (ex.code !== 'EEXIST')
      throw ex;
  }
  try {
    unlinkSync(dbPath);
  } catch (ex) {
    if (ex.code !== 'ENOENT') {
      rmdirSync(basePath);
      throw ex;
    }
  }

  try {
    await new Promise((resolve, reject) => {
      // Create an encrypted database
      const db = new Database(dbPath);
      db.open();
      db.query(`PRAGMA key = 'foobarbaz'`, (err, rows) => {
        try {
          assert.ifError(err);
          assert.deepStrictEqual(rows, [ { ok: 'ok' } ]);
        } catch (ex) {
          return reject(ex);
        }

        db.query(`
          CREATE TABLE data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(50)
          );
          INSERT INTO data (name) VALUES ('Foo');
          INSERT INTO data (name) VALUES ('Bar');
        `, { single: false }, (err, rows) => {
          try {
            assert.deepStrictEqual(err, [ null, null, null ]);
            assert.deepStrictEqual(rows, [ [], [], [] ]);
            db.close();
          } catch (ex) {
            return reject(ex);
          }
          resolve();
        });
      });
    });

    await new Promise((resolve, reject) => {
      // Re-open and querying without key set should fail
      const db = new Database(dbPath);
      db.open();
      db.query('SELECT * FROM data', (err, rows) => {
        try {
          assert(err instanceof Error);
          assert(!rows);
          db.close();
        } catch (ex) {
          return reject(ex);
        }
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      // Re-open and querying with wrong key set should fail
      const db = new Database(dbPath);
      db.open();
      db.query(`PRAGMA key = 'bazbarfoo'`, (err, rows) => {
        try {
          assert.ifError(err);
          assert.deepStrictEqual(rows, [ { ok: 'ok' } ]);
        } catch (ex) {
          return reject(ex);
        }

        db.query('SELECT * FROM data', (err, rows) => {
          try {
            assert(err instanceof Error);
            assert(!rows);
            db.close();
          } catch (ex) {
            return reject(ex);
          }
          resolve();
        });
      });
    });

    await new Promise((resolve, reject) => {
      // Re-opening with wrong cipher set should fail
      const db = new Database(dbPath);
      db.open();
      db.query(`PRAGMA cipher = 'sqlcipher'`, (err, rows) => {
        try {
          assert(err instanceof Error);
          assert(!rows);
          db.close();
        } catch (ex) {
          return reject(ex);
        }
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      // Re-open and querying with correct key set should succeed
      const db = new Database(dbPath);
      db.open();
      db.query(`PRAGMA key = 'foobarbaz'`, (err, rows) => {
        try {
          assert.ifError(err);
          assert.deepStrictEqual(rows, [ { ok: 'ok' } ]);
        } catch (ex) {
          return reject(ex);
        }

        db.query('SELECT * FROM data', (err, rows) => {
          try {
            assert.ifError(err);
            assert.deepStrictEqual(rows, [
              { id: '1', name: 'Foo' },
              { id: '2', name: 'Bar' },
            ]);
            db.close();
          } catch (ex) {
            return reject(ex);
          }
          resolve();
        });
      });
    });

    await new Promise((resolve, reject) => {
      // Re-opening with cipher set explicitly and querying with correct key
      // set should succeed
      const db = new Database(dbPath);
      db.open();
      db.query(`PRAGMA cipher = 'chacha20'`, (err, rows) => {
        try {
          assert.ifError(err);
          assert.deepStrictEqual(rows, [ { chacha20: 'chacha20' } ]);
        } catch (ex) {
          return reject(ex);
        }

        db.query(`PRAGMA key = 'foobarbaz'`, (err, rows) => {
          try {
            assert.ifError(err);
            assert.deepStrictEqual(rows, [ { ok: 'ok' } ]);
          } catch (ex) {
            return reject(ex);
          }

          db.query('SELECT * FROM data', (err, rows) => {
            try {
              assert.ifError(err);
              assert.deepStrictEqual(rows, [
                { id: '1', name: 'Foo' },
                { id: '2', name: 'Bar' },
              ]);
              db.close();
            } catch (ex) {
              return reject(ex);
            }
            resolve();
          });
        });
      });
    });
  } finally {
    try {
      unlinkSync(dbPath);
    } catch {}
    try {
      rmdirSync(basePath);
    } catch {}
  }
});

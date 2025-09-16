'use strict';

const assert = require('assert');
const { mkdirSync, rmdirSync, unlinkSync } = require('fs');
const { join } = require('path');

const {
  ACTION_CODES,
  Database,
  version,
} = require(join(__dirname, '..', 'lib'));

const { series } = require(join(__dirname, 'common.js'));

assert(/^[0-9.]+ \/ MC [0-9.]+-[a-f0-9]+$/.test(version));

let db;
series([
  (cb) => {
    db = new Database(':memory:');
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
    `, cb);
    assert.throws(() => db.close());
  },
  (cb) => {
    assert.strictEqual(db.autoCommitEnabled(), true);
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
    `, values, cb);
  },
  (cb) => {
    const values = { age: 50 };
    db.query('SELECT * FROM data WHERE age < :age', { values }, (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0], {
        id: '3',
        emailAddress: 'quuy@example.net',
        firstName: 'Quuy',
        lastName: 'Quuz',
        age: '33',
        secret: Buffer.from('ijkl'),
      });
      cb();
    });
  },
  (cb) => {
    db.query('SELECT * FROM data ORDER BY id', (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(rows.length, 4);
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
      cb();
    });
  },
  (cb) => {
    db.query(`
      SELECT 'hello' msg1;
      SELECT 'world' msg2
    `, { single: false }, (err, rows) => {
      if (err)
        return cb(err);
      assert.deepStrictEqual(rows, [
        [ { msg1: 'hello' } ],
        [ { msg2: 'world' } ],
      ]);
      cb();
    });
  },
  (cb) => {
    db.query('THISISNOTVALIDSYNTAX', (err, rows) => {
      assert(err instanceof Error);
      assert(!rows);
      cb();
    });
  },
  (cb) => {
    db.query(`
      SELECT 'hello' msg;
      THISISNOTVALIDSYNTAX
    `, { single: false }, (err, rows) => {
      assert(Array.isArray(err));
      assert.strictEqual(err.length, 2);
      assert(!err[0]);
      assert(err[1] instanceof Error);
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows[0], [ { msg: 'hello' } ]);
      assert(!rows[1]);
      cb();
    });
  },
  (cb) => {
    db.query(`
      THISISNOTVALIDSYNTAX;
      SELECT 'hello' msg
    `, { single: false }, (err, rows) => {
      assert(err instanceof Error);
      assert(!rows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test basic authorizer (allow all)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
      [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
    ];
    const actualAuth = [];
    const expectedRows = [
      { value: '25' }, { value: '50' }, { value: '75' }, { value: '100' },
    ];
    db = new Database(':memory:', (...args) => {
      actualAuth.push(args);
      return true;
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.strictEqual(rows.length, expectedRows.length);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test basic authorizer (ignore READs)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
      [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
    ];
    const actualAuth = [];
    const expectedRows = [
      { value: null }, { value: null }, { value: null }, { value: null },
    ];
    db = new Database(':memory:', (...args) => {
      actualAuth.push(args);
      if (args[0] === ACTION_CODES.SELECT)
        return true;
      return null;
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.strictEqual(rows.length, expectedRows.length);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test basic authorizer (ignore all)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
    ];
    const actualAuth = [];
    const expectedRows = [];
    db = new Database(':memory:', (...args) => {
      actualAuth.push(args);
      return null;
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.strictEqual(rows.length, expectedRows.length);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test basic authorizer (deny all)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
    ];
    const actualAuth = [];
    db = new Database(':memory:', (...args) => {
      actualAuth.push(args);
      return false;
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err) => {
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert(err instanceof Error);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test advanced authorizer (allow all)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
      [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
    ];
    const actualAuth = [];
    const expectedRows = [
      { value: '25' }, { value: '50' }, { value: '75' }, { value: '100' },
    ];
    db = new Database(':memory:', {
      callback: (...args) => {
        actualAuth.push(args);
        return true;
      },
      filter: [ ACTION_CODES.SELECT, ACTION_CODES.READ ],
      filterNoMatchResult: false,
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.strictEqual(rows.length, expectedRows.length);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test advanced authorizer (ignore READs)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
      [ ACTION_CODES.READ, 'generate_series', 'value', 'main', null ],
    ];
    const actualAuth = [];
    const expectedRows = [
      { value: null }, { value: null }, { value: null }, { value: null },
    ];
    db = new Database(':memory:', {
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
      if (err)
        return cb(err);
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.strictEqual(rows.length, expectedRows.length);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test advanced authorizer (ignore all)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
    ];
    const actualAuth = [];
    const expectedRows = [];
    db = new Database(':memory:', {
      callback: (...args) => {
        actualAuth.push(args);
        return null;
      },
      filter: [ ACTION_CODES.SELECT, ACTION_CODES.READ ],
      filterNoMatchResult: false,
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert.strictEqual(rows.length, expectedRows.length);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test advanced authorizer (deny all)
    const expectedAuth = [
      [ ACTION_CODES.SELECT, null, null, null, null ],
    ];
    const actualAuth = [];
    db = new Database(':memory:', {
      callback: (...args) => {
        actualAuth.push(args);
        return false;
      },
      filter: [ ACTION_CODES.SELECT, ACTION_CODES.READ ],
      filterNoMatchResult: false,
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      assert.strictEqual(actualAuth.length, expectedAuth.length);
      assert.deepStrictEqual(actualAuth, expectedAuth);
      assert(err instanceof Error);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test advanced authorizer, no cb (allow SELECTs, ignore others)
    const expectedRows = [
      { value: null }, { value: null }, { value: null }, { value: null },
    ];
    db = new Database(':memory:', {
      filter: [ ACTION_CODES.SELECT ],
      filterMatchResult: true,
      filterNoMatchResult: null,
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      if (err)
        return cb(err);
      assert.strictEqual(rows.length, expectedRows.length);
      assert.deepStrictEqual(rows, expectedRows);
      db.close();
      cb();
    });
  },
  (cb) => {
    // Test advanced authorizer, no cb (deny all)
    db = new Database(':memory:', {
      filter: [],
      filterMatchResult: true,
      filterNoMatchResult: false,
    });
    db.open();
    db.query('SELECT * FROM generate_series(25,100,25)', (err, rows) => {
      assert(err instanceof Error);
      db.close();
      cb();
    });
  },
  (cb) => {
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
    cb();
  },
  (cb) => {
    const basePath = join(__dirname, 'tmp');
    const dbPath = join(basePath, 'encrypted.db');
    try {
      mkdirSync(basePath);
    } catch (ex) {
      if (ex.code !== 'EEXIST')
        return cb(ex);
    }
    try {
      unlinkSync(dbPath);
    } catch (ex) {
      if (ex.code !== 'ENOENT')
        return cb(ex);
    }

    series([
      (cb) => {
        // Create an encrypted database
        db = new Database(dbPath);
        db.open();
        db.query(`PRAGMA key = 'foobarbaz'`, cb);
      },
      (cb) => {
        db.query(`
          CREATE TABLE data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(50)
          );
          INSERT INTO data (name) VALUES ('Mr. Anderson')
        `, { single: false }, (err) => {
          if (err)
            return cb(err);

          db.close();
          cb();
        });
      },
      (cb) => {
        // Re-open and querying without key set should fail
        db = new Database(dbPath);
        db.open();
        db.query('SELECT * FROM data', (err) => {
          assert(err instanceof Error);
          db.close();
          cb();
        });
      },
      (cb) => {
        // Re-open and querying with wrong key set should fail
        db = new Database(dbPath);
        db.open();
        db.query(`PRAGMA key = 'bazbarfoo'`, cb);
      },
      (cb) => {
        db.query('SELECT * FROM data', (err) => {
          assert(err instanceof Error);
          db.close();
          cb();
        });
      },
      (cb) => {
        // Re-opening with wrong cipher set should fail
        db = new Database(dbPath);
        db.open();
        db.query(`PRAGMA cipher = 'sqlcipher'`, (err) => {
          assert(err instanceof Error);
          db.close();
          cb();
        });
      },
      (cb) => {
        // Re-open and querying with correct key set should succeed
        db = new Database(dbPath);
        db.open();
        db.query(`PRAGMA key = 'foobarbaz'`, cb);
      },
      (cb) => {
        db.query('SELECT * FROM data', (err, rows) => {
          if (err)
            return cb(err);
          assert.strictEqual(rows.length, 1);
          db.close();
          cb();
        });
      },
      (cb) => {
        // Re-opening with cipher set explicitly and querying with correct key
        // set should succeed
        db = new Database(dbPath);
        db.open();
        db.query(`PRAGMA cipher = 'chacha20'`, cb);
      },
      (cb) => {
        db.query(`PRAGMA key = 'foobarbaz'`, cb);
      },
      (cb) => {
        db.query('SELECT * FROM data', (err, rows) => {
          if (err)
            return cb(err);
          assert.strictEqual(rows.length, 1);
          db.close();
          cb();
        });
      },
      (cb_) => {
        unlinkSync(dbPath);
        rmdirSync(basePath);
        cb_();
        cb();
      },
    ]);
  },
]);

'use strict';

const assert = require('assert');
const { join } = require('path');

const { Database } = require(join(__dirname, '..', 'lib'));

process.on('exit', () => {
  assert.deepStrictEqual(result, [1, 2, 3]);
});

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
  assert.ifError(err);
  result.push(1);
});

{
  const values = [
    'foo@example.org', 'Foo', 'Bar', null, Buffer.from('abcd'),
  ];
  db.query(`
    INSERT INTO data (emailAddress, firstName, lastName, age, secret)
    VALUES (?, ?, ?, ?, ?)
  `, values, (err) => {
    assert.ifError(err);
    result.push(2);
  });
}

db.query('SELECT * FROM data', (err, rows) => {
  assert.ifError(err);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    id: '1',
    emailAddress: 'foo@example.org',
    firstName: 'Foo',
    lastName: 'Bar',
    age: null,
    secret: Buffer.from('abcd'),
  });
  result.push(3);
});

db.end();

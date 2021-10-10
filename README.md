Description
===========

An SQLite (more accurately [SQLite3MultipleCiphers](https://utelle.github.io/SQLite3MultipleCiphers/)) binding for [node.js](https://nodejs.org) focused on simplicity and (async) performance.

When dealing with encrypted sqlite databases, this binding only supports the
ChaCha20-Poly1305 cipher to keep things simple, secure, and working well across
multiple platforms.

Available/Relevant special `PRAGMA`s:

* [`PRAGMA kdf_iter`](https://utelle.github.io/SQLite3MultipleCiphers/docs/configuration/config_sql_pragmas/#pragma-kdf_iter)
* [`PRAGMA key`](https://utelle.github.io/SQLite3MultipleCiphers/docs/configuration/config_sql_pragmas/#pragma-key)
* [`PRAGMA rekey`](https://utelle.github.io/SQLite3MultipleCiphers/docs/configuration/config_sql_pragmas/#pragma-rekey)

Table of Contents
=================

* [Implementation/Design Notes](#implementationdesign-notes)
* [Performance](#performance)
* [Requirements](#requirements)
* [Installation](#installation)
* [Examples](#examples)
* [API](#api)

# Implementation/Design Notes

The goal of this addon/binding is to provide a simple and consistent interface
for interacting with SQLite databases. What that means on a technical level is:

  * Only synchronous opening and closing of databases
    * **Why?** To simplify things. Opening and closing should be fast enough and
      are typically not done that often anyway.

  * Only async queries, which are processed in a queue
    * **Why?** Async because queries could easily have the potential to disrupt
      the node.js event loop. A per-connection queue is used because of the
      threading model used with SQLite, which not only avoids a lot of extra
      mutexes but also avoids various race conditions that can still occur even
      with SQLite in a serialized/"thread-safe" threading model.

  * Only strings, `null`, and `Buffer`s for column values
    * **Why?** To provide a consistent set of data types without any "gotchas."
      In particular there is no awkward number value handling that plagues a lot
      of node.js database bindings in general due to JavaScript's use of a
      double type for its numbers (although there is built-in bigint now, it is
      a separate type and can't be used with regular JavaScript numbers very
      easily).

      Some bindings deal with this problem by allowing you to configure
      number-handling behavior, however in general that ultimately means you
      will probably end up adding some kind of type checking and whatnot when
      processing query results to support different configurations.

  * Only SQLite's UTF-8 APIs are used/supported
    * **Why?** To be clear, this doesn't mean databases utilizing UTF-16 can't
      be used with this addon, it just means that SQLite will be forced to do
      some transformations that would ordinarily be unnecessary with a database
      that used UTF-8 for string values from the get-go. This incurs additional
      overhead when executing queries. Also, SQLite has some APIs that only
      accept UTF-8 strings anyway so it makes even more sense from a
      consistency perspective.

# Performance

When discussing performance (particularly node.js sqlite driver performance),
it's important to reiterate that your mileage may vary and that it mostly boils
down to how the sqlite database is accessed. Specifically I'm referring to
synchronous vs. asynchronous. Both have their advantages and disadvantages and
have different scaling properties.

Because `esqlite` only provides an async API and the fact that sqlite directly
accesses the disk, it means queries run in the thread pool to ensure the main
thread is not blocked. With other types of databases where you make a network
connection to the database, this is unnecessary and can be done without the
thread pool (and without writing/using C/C++ code) because you're simply waiting
for I/O, which node.js can easily and more efficiently do.

With that in mind, what this means is that for some workloads, synchronous
queries will perform better than asynchronous queries because of the overhead
of queueing work to the thread pool and the additional copying of results
because you cannot access V8 APIs from threads in a *node addon*.

For benchmarking, I generated a single, unencrypted database with 100k records.
The schema looked like:

```sql
CREATE TABLE data (
  ID INT,
  EmailAddress VARCHAR(500),
  FirstName VARCHAR(500),
  LastName VARCHAR(500),
  IPAddress VARCHAR(500),
  Age INT
)
```

The node.js version benchmarked with here was **v16.10.0**. I did however notice
that older node.js branches (e.g. v10.x) performed *better*, for example:
`esqlite` was ~20ms faster in the 100k row fetching benchmark with
node v10.22.1 compared to node v16.10.0.

The sqlite packages being benchmarked:

Package          | Version
-----------------|--------:
[better-sqlite3] | 7.4.3
[esqlite]        | 0.0.1
[sqlite3]        | 5.0.2
[sqlite3 (PR)]   | 5.0.2

[better-sqlite3]: https://github.com/JoshuaWise/better-sqlite3
[esqlite]: https://github.com/mscdex/esqlite
[sqlite3]: https://github.com/mapbox/node-sqlite3
[sqlite3 (PR)]: https://github.com/mapbox/node-sqlite3/pull/1471

Here is the code and the results for a couple of different queries that I ran on
my Linux desktop:

* `SELECT * FROM data` (retrieves all 100k rows)

  * Code

    * `better-sqlite3`
        ```js
        const openDB = require('better-sqlite3');
        const db = openDB('/tmp/test.db', { readonly: true });

        console.time('select');
        db.prepare('SELECT * FROM data').all();
        console.timeEnd('select');
        db.close();
        ```
    * `esqlite`
        ```js
        const { Database, OPEN_FLAGS } = require('esqlite');
        const db = new Database('/tmp/test.db');
        db.open(OPEN_FLAGS.READONLY);

        console.time('select');
        db.query('SELECT * FROM data', () => {
          console.timeEnd('select');
          db.close();
        });
        ```
    * `sqlite3` / `sqlite3 (PR)`
        ```js
        const sqlite3 = require('sqlite3');
        const db = new sqlite3.Database('/tmp/test.db', sqlite3.OPEN_READONLY);

        console.time('select');
        db.all('SELECT * FROM data', () => {
          console.timeEnd('select');
          db.close();
        });
        ```

  * Results

    Package        | Average time (ms) | Average max RSS (MB)
    ---------------|------------------:|---------------------:
    better-sqlite3 | `350`             | `89`
    esqlite        | `200`             | `117`
    sqlite3        | `760`             | `160`
    sqlite3 (PR)   | `390`             | `132`

* `SELECT * FROM data LIMIT 1000`

  * Code same as before, but with the SQL string changed appropriately

  * Results

    Package        | Average time (ms) | Average max RSS (MB)
    ---------------|------------------:|---------------------:
    better-sqlite3 | `3`               | `38.0`
    esqlite        | `3`               | `35.0`
    sqlite3        | `10`              | `42.0`
    sqlite3 (PR)   | `5`               | `41.5`

* `SELECT * FROM data LIMIT 10`

  * Code same as before, but with the SQL string changed appropriately

  * Results

    Package        | Average time (ms) | Average max RSS (MB)
    ---------------|------------------:|---------------------:
    better-sqlite3 | `0.300`           | `38`
    esqlite        | `1.000`           | `34`
    sqlite3        | `0.800`           | `41`
    sqlite3 (PR)   | `0.800`           | `41`


# Requirements

* [node.js](http://nodejs.org/)
  * Windows: node v12.x or newer
  * All other platforms: node v10.7.0 or newer
* An appropriate build environment -- see [node-gyp's documentation](https://github.com/nodejs/node-gyp/blob/master/README.md)


# Installation

    npm install esqlite


# Examples

* Create/Open an encrypted database
```js
const { Database } = require('esqlite');

const db = new Database('/path/to/database');
db.open();
db.query(`PRAGMA key = 'my passphrase'`, (err) => {
  if (err) throw err;

  // Perform queries as normal ...

  // ... and eventually close the database
  db.close();
});
```

* Binding values
```js
const { Database } = require('esqlite');

const db = new Database('/path/to/database');
db.open();

// Using nameless/ordered parameters
db.query('SELECT * FROM posts WHERE id = ?', [1234], (err, rows) => {
  if (err) throw err;

  db.close();
});

// Using named parameters
const values = { id: 1234 };
db.query('SELECT * FROM posts WHERE id = :id', { values }, (err, rows) => {
  if (err) throw err;

  db.close();
});
```


# API

## Exports

* `Database` - A class that represents a connection to an SQLite database.

* `OPEN_FLAGS` - *object* - Contains various flags that can be passed to
                            `database.open()`:

    * `CREATE` - The database is created if it does not exist.
    * `MEMORY` - The database will be opened as an in-memory database. The
                 database is named by the `filename` argument passed to the
                 `Database` constructor for the purposes of cache-sharing if
                 shared cache mode is enabled, otherwise the `filename` is
                 ignored.
    * `NOFOLLOW` - When opening the database, the database path is not allowed
                   to be a symbolic link.
    * `PRIVATECACHE` - The database is opened with shared cache disabled.
    * `READONLY` - The database is opened in read-only mode. If the database
                   does not already exist, an error is thrown.
    * `READWRITE` - The database is opened for reading and writing if possible,
                    or reading only if the file is write protected by the
                    operating system. In either case the database must already
                    exist, otherwise an error is thrown.
    * `SHAREDCACHE` - The database is opened with shared cache enabled.

* `PREPARE_FLAGS` - *object* - Contains various flags related to query
                               preparation that can be passed to `query()`:

    * `NO_VTAB` - Causes the query to fail if the statement uses any virtual
                  tables.

* `version` - *string* - Contains the SQLite and SQLite3MultipleCiphers
                         versions.

---

## `Database` methods

* Database(< _string_ >path) - Creates a new `Database` object for operating
  on the database located at `path`.

* autoCommitEnabled() - *boolean* - Returns whether the opened database
  currently has auto-commit enabled.

* close() - *(void)* - Closes the database.

* interrupt(< _function_ >callback) - *(void)* -  Interrupts the currently
  running query. `callback` has no arguments and is called after any query has
  been interrupted.

* open([ < _integer_ >flags ]) - *(void)* -  Opens the database with optional
  flags whose values come from `OPEN_FLAGS`.
  **Default `flags`:** `CREATE | READWRITE`

* query(< _string_ >sql[, < _object_ >options][, < _array_ >values][, < _function_ >callback) -
  Executes the statement(s) in `sql`. `options` may contain:

    * `prepareFlags` - *integer* - Flags to be used during preparation of the
      statement(s) whose values come from `PREPARE_FLAGS`.
      **Default:** (no flags)

    * `single` - *boolean* - Whether only a single statement should be executed
      from `sql`. This can be useful to help avoid some SQL injection attacks.
      **Default:** `true`

    * `values` - *mixed* - Either an object containing named bind parameters and
      their associated values or an array containing values for nameless/ordered
      bind parameters. **Default:** (none)

  If using nameless/ordered values, then an array `values` may be passed
  directly in `query()`.

  If an error occurs while preparing/parsing a statement, further processing
  of `sql` stops immediately (only relevant when `options.single === false`).

  `callback` is called when zero or more of the statement(s) finish and has the
  signature `(err, rows)`. In the case of a single statement, `err` is a
  possible `Error` instance and `rows` is a possible array of rows returned from
  the statement. In the case of multiple statements, if any one of the
  statements ended in an error, then `err` will be an array. If there was no
  error, `rows` will contain a 2D array of rows, one set of rows per statement.
  It is possible that the length of `err` and/or `rows` will not equal the
  number of statements if there was a fatal error that halted execution of any
  further statements.

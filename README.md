Description
===========

An SQLite (more accurately [SQLite3MultipleCiphers](https://utelle.github.io/SQLite3MultipleCiphers/)) binding for [node.js](https://nodejs.org) focused on simplicity and (async) performance.

Current SQLite version: 3.50.4

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

The node.js version benchmarked with here was **v20.14.0**.

The sqlite packages being benchmarked:

Package          | Version
-----------------|--------:
[better-sqlite3] | 12.2.0
[esqlite]        | 0.0.21
[sqlite3]        | 5.1.7

[better-sqlite3]: https://github.com/WiseLibs/better-sqlite3
[esqlite]: https://github.com/mscdex/esqlite
[sqlite3]: https://github.com/TryGhost/node-sqlite3

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
    * `sqlite3`
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
    better-sqlite3 | `121`             | `101`
    esqlite        | `88`              | `129`
    sqlite3        | `189`             | `146`

* `SELECT * FROM data LIMIT 1000`

  * Code same as before, but with the SQL string changed appropriately

  * Results

    Package        | Average time (ms) | Average max RSS (MB)
    ---------------|------------------:|---------------------:
    better-sqlite3 | `1.5`             | `51`
    esqlite        | `1.3`             | `50`
    sqlite3        | `2.3`             | `47`

* `SELECT * FROM data LIMIT 10`

  * Code same as before, but with the SQL string changed appropriately

  * Results

    Package        | Average time (ms) | Average max RSS (MB)
    ---------------|------------------:|---------------------:
    better-sqlite3 | `0.185`           | `50`
    esqlite        | `0.500`           | `46`
    sqlite3        | `0.603`           | `47`


# Requirements

* [node.js](http://nodejs.org/)
  * Windows: node v12.x or newer
  * All other platforms: Latest node v10.x or newer
* An appropriate build environment -- see [node-gyp's documentation](https://github.com/nodejs/node-gyp/blob/main/README.md)


# Installation

    npm install esqlite


# Examples

* Create/Open an encrypted database
```js
const { Database } = require('esqlite');

const db = new Database('/path/to/database');
db.open();
db.query(`PRAGMA key = 'my passphrase'`, (err) => {
  if (err)
    throw err;

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
  if (err)
    throw err;

  db.close();
});

// Using named parameters
const values = { id: 1234 };
db.query('SELECT * FROM posts WHERE id = :id', { values }, (err, rows) => {
  if (err)
    throw err;

  db.close();
});
```

* Streaming rows
```js
const { Database } = require('esqlite');

(async () => {
  const db = new Database('/path/to/database');
  db.open();

  // Stream rows one at a time
  const stmt =
    db.queryAsync('SELECT created, title FROM posts ORDER BY created DESC');
  for await (const rows of stmt)
    console.log(rows);

  // Stream rows five at a time
  const stmt =
    db.queryAsync('SELECT created, title FROM posts ORDER BY created DESC');
  for await (const rows of stmt.iterate(5))
    console.log(rows);

  // Execute multiple statements, streaming five rows at a time from each
  const iter = db.queryMultiAsync(`
    SELECT title FROM posts ORDER BY created DESC;
    SELECT title FROM posts ORDER BY title ASC
  `);
  for await (const stmt of iter) {
    for await (const rows of stmt.iterate(5))
      console.log(rows);
  }

  db.close();
})();
```


# API

## Exports

* **Database** - A class that represents a connection to an SQLite database.

* **ACTION_CODES** - _object_ - Contains currently known SQLite action codes as
  seen [here][1], keyed on the name minus the `SQLITE_` prefix.

* **OPEN_FLAGS** - _object_ - Contains various flags that can be passed to
  `database.open()`:

    * **CREATE** - The database is created if it does not exist.
    * **MEMORY** - The database will be opened as an in-memory database. The
      database is named by the `filename` argument passed to the `Database`
      constructor for the purposes of cache-sharing if shared cache mode is
      enabled, otherwise the `filename` is ignored.
    * **NOFOLLOW** - When opening the database, the database path is not allowed
      to be a symbolic link.
    * **PRIVATECACHE** - The database is opened with shared cache disabled.
    * **READONLY** - The database is opened in read-only mode. If the database
      does not already exist, an error is thrown.
    * **READWRITE** - The database is opened for reading and writing if
      possible, or reading only if the file is write protected by the operating
      system. In either case the database must already exist, otherwise an error
      is thrown.
    * **SHAREDCACHE** - The database is opened with shared cache enabled.

* **PREPARE_FLAGS** - _object_ - Contains various flags related to query
  preparation that can be passed to `query()`:

    * **NO_VTAB** - Causes the query to fail if the statement uses any virtual
      tables.

* **version** - _string_ - Contains the SQLite and SQLite3MultipleCiphers
  versions.

---

## `Database` methods

* **(constructor)**(< _string_ >path[, < _mixed_ >authorizer]) - Creates a new
  `Database` object for operating on the database located at `path`. If
   specified, `authorizer` must be one of:

    * _function_ - A callback with signature: (< _integer_ >actionCode, < _mixed_ >arg1, < _mixed_ >arg2, < _mixed_ >arg3, < _mixed_ >arg4)

    * _object_

      * **callback** - _function_ - An optional callback with signature: (< _integer_ >actionCode, < _mixed_ >arg1, < _mixed_ >arg2, < _mixed_ >arg3, < _mixed_ >arg4)

      * **filter** - _array_ - An array containing action code values. If
        `callback` is provided, only these action codes will be passed to the
        `callback` and all others will be automatically handled according to the
        value in `filterNoMatchResult`. If `callback` is *not* provided, then
        these action codes will be automatically handled according to the value
        in `filterMatchResult` and all others according to the value in
        `filterNoMatchResult`.

      * **filterMatchResult** - _mixed_ - If `callback` is not provided, must be
         one of: `true`, `false`, `null`.

      * **filterNoMatchResult** - _mixed_ - Must be one of: `true`, `false`, `null`.

    `actionCode` values can generally be found [here][1].

    For callbacks, the contents of `arg1` through `arg4` depend on the
    `actionCode` and will either be `null` or a string. See the notes [here][1]
    to discover what the values are for each `actionCode`.

    The return values of callbacks and the values of `filterMatchResult` and
    `filterNoMatchResult` have the following mapping to the underlying SQLite
    authorizer values:

    * `true` => `SQLITE_OK`

    * `false` => `SQLITE_DENY`

    * `null` => `SQLITE_IGNORE`

    The meaning of these values can be found [here][1].

* **autoCommitEnabled**() - _boolean_ - Returns whether the opened database
  currently has auto-commit enabled.

* **close**() - _(void)_ - Closes the database.

* **end**() - _(void)_ - Automatically closes the database when the query queue
  is empty. If the queue is empty when `end()` is called, then the database is
  immediately closed.

* **interrupt**(< _function_ >callback) - _(void)_ -  Interrupts the currently
  running query. `callback` has no arguments and is called after any query has
  been interrupted.

* **open**([ < _integer_ >flags ]) - _(void)_ -  Opens the database with optional
  flags whose values come from `OPEN_FLAGS`.
  **Default `flags`:** `CREATE | READWRITE`

* **query**(< _string_ >sql[, < _object_ >options][, < _array_ >values][, < _function_ >callback]) - _(void)_ -
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

  `callback` is called when processing of `sql` has finished and has the
  signature `(err, rows)`.

    * In the case of a single statement, `err` is a possible `Error` instance
      and `rows` is a possible array of rows returned from the statement.

    * In the case of multiple statements, `err` will be an array containing
      either `null` or `Error` instance values. `rows` will be an array
      containing zero or more of: `undefined` for statements with a
      corresponding error or an array of rows for statements with no error.

* **queryAsync**(< _string_ >sql[, < _object_ >options][, < _array_ >values]) - *Statement* -
  Returns a *Statement* that executes only the first statement in `sql`.
  `options` may contain:

    * **prepareFlags** - *integer* - Flags to be used during preparation of the
      statement(s) whose values come from `PREPARE_FLAGS`.
      **Default:** (no flags)

    * **abortType** - _string_ - Sets the default implicit abort behavior when
      breaking out of a `for await` loop. Can be one of:

      * `'all'` - Abort current and any remaining statements

      * `'current'` - Abort only current statement

      * `'none'` - Do nothing

    * **values** - *mixed* - Either an object containing named bind parameters and
      their associated values or an array containing values for nameless/ordered
      bind parameters. **Default:** (none)

  If using nameless/ordered values, then an array `values` may be passed
  directly in `query()`.

* **queryMultiAsync**(< _string_ >sql[, < _object_ >options][, < _array_ >values]) - *StatementIterator* -
  Returns a *StatementIterator* that executes all of the statement(s) in `sql`.
  `options` may contain:

    * **prepareFlags** - _integer_ - Flags to be used during preparation of the
      statement(s) whose values come from `PREPARE_FLAGS`.
      **Default:** (no flags)

    * **abortType** - _string_ - Sets the default implicit abort behavior when
      breaking out of a `for await` loop. Can be one of:

      * `'all'` - Abort current and any remaining statements

      * `'current'` - Abort only current statement

      * `'none'` - Do nothing

    * **values** - _mixed_ - Either an object containing named bind parameters and
      their associated values or an array containing values for nameless/ordered
      bind parameters. **Default:** (none)

  If using nameless/ordered values, then an array `values` may be passed
  directly in `query()`.

## `Statement` methods

  * (Implements the Async Iterator and Async Dispose interfaces. By default when
     iterating, only one row will be retrieved at a time.)

  * **abort**() - _Promise_ - Aborts the statement. The returned promise is
    resolved when the statement has been successfully aborted.

  * **execute**([< _integer_ >rowCount]) - _Promise_ - Executes the statement,
    optionally requesting `rowCount` rows. If `rowCount` is not given, all rows
    left for the statement will be retrieved. The returned promise is resolved
    when the requested number of rows have been retrieved or the statement has
    finished execution, whichever happens first.

  * **setAbortType**(< _string_ >abortType) - _(void)_ - Sets the statement's
    implicit abort behavior when breaking out of `for await` loops.

  * **iterate**([< _integer_ >rowCount][, < _string_ >abortType]) - _AsyncIterator_ -
    Returns an independent async iterator that optionally requests a given number
    of rows (instead of the default of one row) and optionally sets the implicit
    abort behavior when breaking out of `for await` loops using this iterator.
    If `rowCount` is not given, all rows left for the statement will be retrieved.
    If `abortType` is not given, the `abortType` is inherited from the statement.
    The returned promise is resolved when the requested number of rows have been
    retrieved or the statement has finished execution, whichever happens first.

## `StatementIterator` methods

  * (Implements the Async Iterator and Async Dispose interfaces.)

  * **abort**() - _Promise_ - Aborts any/all statements for the query. The
    returned promise is resolved when either any/all statements have been
    successfully aborted, according to the abort behavior option passed to
    `queryMultiAsync()`.

  * **setAbortType**(< _string_ >abortType) - _(void)_ - Sets the iterator's
    implicit abort behavior when breaking out of `for await` loops.

[1]: https://www.sqlite.org/c3ref/c_alter_table.html

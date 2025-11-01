'use strict';

const { DBHandle, version } = require('../build/Release/esqlite3.node');

const OPEN_FLAGS = {
  READONLY: 0x00000001,
  READWRITE: 0x00000002,
  CREATE: 0x00000004,
  MEMORY: 0x00000080,
  SHAREDCACHE: 0x00020000,
  PRIVATECACHE: 0x00040000,
  NOFOLLOW: 0x01000000,
};
const ACTION_CODES = {
  COPY: 0,
  CREATE_INDEX: 1,
  CREATE_TABLE: 2,
  CREATE_TEMP_INDEX: 3,
  CREATE_TEMP_TABLE: 4,
  CREATE_TEMP_TRIGGER: 5,
  CREATE_TEMP_VIEW: 6,
  CREATE_TRIGGER: 7,
  CREATE_VIEW: 8,
  DELETE: 9,
  DROP_INDEX: 10,
  DROP_TABLE: 11,
  DROP_TEMP_INDEX: 12,
  DROP_TEMP_TABLE: 13,
  DROP_TEMP_TRIGGER: 14,
  DROP_TEMP_VIEW: 15,
  DROP_TRIGGER: 16,
  DROP_VIEW: 17,
  INSERT: 18,
  PRAGMA: 19,
  READ: 20,
  SELECT: 21,
  TRANSACTION: 22,
  UPDATE: 23,
  ATTACH: 24,
  DETACH: 25,
  ALTER_TABLE: 26,
  REINDEX: 27,
  ANALYZE: 28,
  CREATE_VTABLE: 29,
  DROP_VTABLE: 30,
  FUNCTION: 31,
  SAVEPOINT: 32,
  RECURSIVE: 33,
};
const DEFAULT_OPEN_FLAGS = (OPEN_FLAGS.READWRITE | OPEN_FLAGS.CREATE);
const OPEN_FLAGS_MASK = Object.values(OPEN_FLAGS).reduce((prev, cur) => {
  return (prev | cur);
});

const PREPARE_FLAGS = {
  NO_VTAB: 0x04,
};
const DEFAULT_PREPARE_FLAGS = 0x00;
const PREPARE_FLAGS_MASK = Object.values(PREPARE_FLAGS).reduce((prev, cur) => {
  return (prev | cur);
});

const QUERY_FLAG_SINGLE = 0x01;
const QUERY_FLAG_NAMED_PARAMS = 0x02;
const QUERY_FLAG_ROWS_AS_ARRAY = 0x04;

const QUERY_STATUS_COMPLETE = 0x01;
const QUERY_STATUS_INCOMPLETE = 0x02;
const QUERY_STATUS_ERROR = 0x03;
const QUERY_STATUS_DONE = 0x04;

const kPath = Symbol('Database path');
const kHandle = Symbol('Database handle');
const kQueue = Symbol('Database query queue');
const kAutoClose = Symbol('Database auto closing');
const kDatabase = Symbol('Database reference');
const kBusy = Symbol('Database is busy');
const kBuffer = Symbol('Query buffered output');
const kSlot = Symbol('Active query entry');
const kAborting = Symbol('Query is aborting');
const kAborter = Symbol('Query aborter');
const kDone = Symbol('Query done');
const kError = Symbol('Query final error');
const kIsNew = Symbol('Query is new');
const kArgs = Symbol('Query arguments');
const kParent = Symbol('Statement parent');
const kAbortAll = Symbol('Query should abort all statements');
const kResume = Symbol('Iterator should resume');
const kAsyncIterAbort = Symbol('Async iterator break handling');

const ABORT_TYPES = new Set([ 'none', 'all', 'current' ]);

const withResolvers = (() => {
  let resolve_;
  let reject_;
  const cb = (res, rej) => {
    resolve_ = res;
    reject_ = rej;
  };
  return (n) => {
    const promise = new Promise(cb);
    const resolve = resolve_;
    const reject = reject_;
    resolve_ = undefined;
    reject_ = undefined;
    return { promise, resolve, reject, n };
  };
})();

class Statement {
  constructor(abortType, db, sqlOrIter, prepareFlags, flags, vals) {
    this[kDatabase] = db;
    this[kAborting] = false;
    this[kAborter] = null;
    this[kAsyncIterAbort] = abortType;
    this[kDone] = false;
    this[kError] = null;
    this[kSlot] = null;
    this[kIsNew] = true;
    if (typeof sqlOrIter === 'string') {
      this[kArgs] = [ sqlOrIter, prepareFlags, flags, vals ];
      this[kParent] = db;
      this[kAbortAll] = true;
    } else {
      this[kArgs] = null;
      this[kParent] = sqlOrIter;
      this[kAbortAll] = false;
    }
    this[kQueue] = [];
    this.colCount = undefined;
  }

  abort() {
    if (!this[kAborter])
      this[kAborter] = withResolvers();
    if (this[kDone]) {
      if (!this[kAborting])
        this[kAborter].resolve();
      return this[kAborter].promise;
    }
    this[kAborting] = true;
    this[kError] = new Error('Statement aborted');
    this[kDone] = true;
    for (const { reject } of this[kQueue])
      reject(this[kError]);
    this[kQueue] = [];
    if (this[kParent][kSlot] === this) {
      if (!this[kDatabase][kBusy]) {
        const onDoneAborting = () => {
          this[kDatabase][kBusy] = false;
          this[kAborter].resolve();
          this[kParent][kSlot] = null;
          processQueue(this[kDatabase]);
        };
        const active = this[kDatabase][kHandle].abort(
          this[kAbortAll],
          onDoneAborting
        );
        if (active)
          this[kDatabase][kBusy] = true;
        else
          onDoneAborting();
      }
    } else {
      const idx = this[kParent][kQueue].indexOf(this);
      if (idx !== -1)
        this[kParent][kQueue].splice(idx, 1);
      this[kAborter].resolve();
    }
    return this[kAborter].promise;
  }

  execute(n) {
    if (this[kDone]) {
      if (this[kError])
        return Promise.reject(this[kError]);
      return Promise.resolve();
    }

    if (n === undefined || n === null)
      n = 0;
    else if (!Number.isInteger(n) || n <= 0 || n > (2 ** 32 - 1))
      throw new TypeError(`Invalid row count value: ${n}`);

    const entry = withResolvers(n);
    this[kQueue].push(entry);
    if (this[kParent][kSlot] === this) {
      if (!this[kSlot])
        processQueue(this[kDatabase]);
    }
    return entry.promise;
  }

  async next() {
    const value = await this.execute(1);
    if (value)
      return { done: false, value };
    return { done: true };
  }

  async return() {
    if (this[kAsyncIterAbort] === 'none')
      return { done: false };
    await this.abort();
    return { done: true };
  }

  setAbortType(abortType) {
    if (!ABORT_TYPES.has(abortType))
      throw new Error(`Invalid abort type: ${abortType}`);
    this[kAsyncIterAbort] = abortType;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  iterate(n, abortType) {
    if (typeof n === 'string') {
      abortType = n;
      n = undefined;
    }
    if (abortType !== undefined) {
      if (typeof abortType !== 'string' || !ABORT_TYPES.has(abortType))
        throw new Error(`Invalid abort type: ${abortType}`);
    } else {
      abortType = this[kAsyncIterAbort];
    }

    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: async () => {
            const value = await this.execute(n);
            if (value)
              return { done: false, value };
            return { done: true };
          },
          return: async () => {
            if (abortType === 'none')
              return { done: false };
            await this.abort();
            return { done: true };
          },
        };
      },
      [Symbol.asyncDispose]: () => {
        return this.abort();
      },
    };
  }

  [Symbol.asyncDispose]() {
    return this.abort();
  }
}

class StatementIterator {
  constructor(abortType, db, sql, prepareFlags, flags, vals) {
    this[kDatabase] = db;
    this[kAborting] = false;
    this[kAborter] = null;
    this[kAsyncIterAbort] = abortType;
    this[kDone] = false;
    this[kSlot] = null;
    this[kArgs] = [ sql, prepareFlags, flags, vals ];
    this[kQueue] = [];
    this[kResume] = false;
    this[kAbortAll] = true;
  }

  async abort() {
    if (!this[kAborter])
      this[kAborter] = withResolvers();
    if (this[kDone]) {
      if (!this[kAborting])
        this[kAborter].resolve();
      return await this[kAborter].promise;
    }
    this[kAborting] = true;
    this[kError] = new Error('Statement iterator aborted');
    this[kDone] = true;
    for (const { reject } of this[kQueue])
      reject(this[kError]);
    this[kQueue] = [];
    if (this[kDatabase][kSlot] === this) {
      if (this[kDatabase][kBusy]) {
        this[kSlot][kAbortAll] = true;
        await this[kSlot].abort();
        this[kAborter].resolve();
      } else {
        const onDoneAborting = () => {
          this[kDatabase][kBusy] = false;
          this[kAborter].resolve();
          this[kDatabase][kSlot] = null;
          processQueue(this[kDatabase]);
        };
        const active = this[kDatabase][kHandle].abort(
          this[kAbortAll],
          onDoneAborting
        );
        if (active)
          this[kDatabase][kBusy] = true;
        else
          onDoneAborting();
      }
    } else {
      const idx = this[kDatabase][kQueue].indexOf(this);
      if (idx !== -1)
        this[kDatabase][kQueue].splice(idx, 1);
      this[kAborter].resolve();
    }
    return await this[kAborter].promise;
  }

  async next() {
    if (this[kDone]) {
      if (this[kError])
        throw this[kError];
      return { done: true };
    }
    if (this[kResume]) {
      this[kResume] = false;
      if (this[kSlot])
        return { done: false, value: this[kSlot] };
    }
    const entry = withResolvers(undefined);
    this[kQueue].push(entry);
    if (this[kDatabase][kSlot] === this) {
      if (this[kSlot])
        await this[kSlot].abort();
      processQueue(this[kDatabase]);
    }
    return await entry.promise;
  }

  async return() {
    if (this[kAsyncIterAbort] === 'all') {
      await this.abort();
    } else if (this[kAsyncIterAbort] === 'none') {
      this[kResume] = true;
      return { done: false };
    }
    return { done: true };
  }

  setAbortType(abortType) {
    if (!ABORT_TYPES.has(abortType))
      throw new Error(`Invalid abort type: ${abortType}`);
    this[kAsyncIterAbort] = abortType;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  [Symbol.asyncDispose]() {
    return this.abort();
  }
}

function processQueue(db) {
  let current = db[kSlot];
  if (current) {
    if (Array.isArray(current))
      return;
    if (current[kAborting]) {
      // Either an iterator or an independent statement is aborting
      const active = db[kHandle].abort(current[kAbortAll], () => {
        db[kBusy] = false;
        current[kAborter].resolve();
        db[kSlot] = null;
        processQueue(db);
      });
      if (active)
        db[kBusy] = true;
      return;
    }

    if (current[kParent]) {
      // Independent statement
      const stmt = current;
      if (stmt[kSlot])
        return;
      if (stmt[kQueue].length) {
        stmt[kSlot] = stmt[kQueue].shift();
        const args = stmt[kArgs];
        if (args) {
          stmt[kArgs] = null;
          try {
            db[kHandle].query(
              args[0], args[1], args[2], args[3], stmt[kSlot].n
            );
          } catch (ex) {
            process.nextTick(
              () => statusCallback.call(db, QUERY_STATUS_ERROR, true, ex)
            );
            return;
          }
        } else {
          db[kHandle].query(stmt[kSlot].n);
        }
        db[kBusy] = true;
      }
    } else {
      // Iterator
      const iter = current;
      let stmt = iter[kSlot];
      if (stmt) {
        if (stmt[kAborting]) {
          const active = db[kHandle].abort(stmt[kAbortAll], () => {
            db[kBusy] = false;
            stmt[kAborter].resolve();
            iter[kSlot] = null;
            processQueue(db);
          });
          if (active)
            db[kBusy] = true;
          return;
        }
        if (stmt[kSlot])
          return;
      } else if (iter[kQueue].length) {
        iter[kSlot] = stmt = new Statement(iter[kAsyncIterAbort], db, iter);
        iter[kQueue].shift().resolve({ done: false, value: stmt });
      }
      if (stmt && stmt[kQueue].length) {
        stmt[kSlot] = stmt[kQueue].shift();
        const args = iter[kArgs];
        if (args) {
          iter[kArgs] = null;
          try {
            db[kHandle].query(
              args[0], args[1], args[2], args[3], stmt[kSlot].n
            );
          } catch (ex) {
            process.nextTick(
              () => statusCallback.call(db, QUERY_STATUS_ERROR, true, ex)
            );
            return;
          }
        } else {
          db[kHandle].query(stmt[kSlot].n);
        }
        db[kBusy] = true;
      }
    }
    return;
  }

  if (db[kQueue].length) {
    db[kSlot] = current = db[kQueue].shift();
    if (Array.isArray(current)) {
      try {
        db[kHandle].query(current[0], current[1], current[2], current[3], 0);
      } catch (ex) {
        process.nextTick(
          () => statusCallback.call(db, QUERY_STATUS_ERROR, true, ex)
        );
        return;
      }
      db[kBusy] = true;
    } else if (current[kParent]) {
      // Independent statement
      const stmt = current;
      if (stmt[kQueue].length) {
        stmt[kSlot] = stmt[kQueue].shift();
        const args = stmt[kArgs];
        stmt[kArgs] = null;
        try {
          db[kHandle].query(args[0], args[1], args[2], args[3], stmt[kSlot].n);
        } catch (ex) {
          process.nextTick(
            () => statusCallback.call(db, QUERY_STATUS_ERROR, true, ex)
          );
          return;
        }
        db[kBusy] = true;
      }
    } else {
      // Iterator
      const iter = current;
      if (iter[kQueue].length) {
        const stmt = new Statement(iter[kAsyncIterAbort], db, iter);
        iter[kQueue].shift().resolve({ done: false, value: stmt });
      }
    }
  } else if (db[kAutoClose]) {
    db[kHandle].close();
  }
}

class Database {
  constructor(path, authorizer) {
    if (typeof path !== 'string')
      throw new Error('Invalid path value');
    this[kPath] = path;
    this[kAutoClose] = false;

    let authorizeFn;
    let authorizeFilter;
    let authorizeMatchResult;
    let authorizeNoMatchResult;
    if (typeof authorizer === 'function') {
      authorizeFn = authorizer;
    } else if (typeof authorizer === 'object' && authorizer !== null) {
      const {
        callback,
        filter,
        filterMatchResult,
        filterNoMatchResult,
      } = authorizer;
      if (typeof callback === 'function') {
        authorizeFn = callback;
        authorizeFilter = filter;
        authorizeNoMatchResult = filterNoMatchResult;
      } else {
        authorizeFn = true;
        authorizeFilter = filter;
        authorizeNoMatchResult = filterNoMatchResult;
        authorizeMatchResult = filterMatchResult;
      }
    }
    // [ errors, rowSets ]
    this[kBuffer] = [ undefined, undefined ];
    this[kBusy] = false;
    this[kSlot] = null;
    this[kQueue] = [];
    this[kHandle] = new DBHandle(
      makeRows,
      makeRowObjFn,
      makeRowArrayFn,
      authorizeFn,
      authorizeFilter,
      authorizeMatchResult,
      authorizeNoMatchResult,
      statusCallback
    );
    this[kHandle].db = this;
  }

  open(flags) {
    if (typeof flags !== 'number')
      flags = DEFAULT_OPEN_FLAGS;
    else
      flags &= OPEN_FLAGS_MASK;
    this[kHandle].open(this[kPath], flags);
    this[kAutoClose] = false;
  }

  queryAsync(sql, opts, vals) {
    if (typeof sql !== 'string')
      throw new TypeError('Invalid sql value');

    let prepareFlags = DEFAULT_PREPARE_FLAGS;
    let flags = QUERY_FLAG_SINGLE;
    let abortType = 'all';
    if (Array.isArray(opts)) {
      // query(sql, vals)
      vals = opts;
      opts = undefined;
    } else if (typeof opts === 'object' && opts !== null) {
      // query(sql, opts)
      if (typeof opts.prepareFlags === 'number')
        prepareFlags = (opts.prepareFlags & PREPARE_FLAGS_MASK);
      if (opts.abortType !== undefined) {
        if (typeof opts.abortType !== 'string'
            || !ABORT_TYPES.has(opts.abortType)) {
          throw new Error(`Invalid abort type: ${opts.abortType}`);
        }
        abortType = opts.abortType;
      }
      if (opts.values !== undefined)
        vals = opts.values;
      if (opts.rowsAsArray === true)
        flags |= QUERY_FLAG_ROWS_AS_ARRAY;
    }
    if (vals && !Array.isArray(vals)) {
      if (typeof vals === 'object' && vals !== null) {
        flags |= QUERY_FLAG_NAMED_PARAMS;
        const keys = Object.keys(vals);
        const valsKV = new Array(keys.length * 2);
        for (let k = 0, p = 0; k < keys.length; ++k, p += 2) {
          const key = keys[k];
          valsKV[p] = `:${key}`;
          valsKV[p + 1] = vals[key];
        }
        vals = valsKV;
      } else {
        throw new TypeError('Invalid query placeholder values type');
      }
    }

    const stmt = new Statement(abortType, this, sql, prepareFlags, flags, vals);
    this[kQueue].push(stmt);
    if (!this[kSlot])
      processQueue(this);
    return stmt;
  }

  queryMultiAsync(sql, opts, vals) {
    if (typeof sql !== 'string')
      throw new TypeError('Invalid sql value');

    let prepareFlags = DEFAULT_PREPARE_FLAGS;
    let flags = 0;
    let abortType = 'all';
    if (Array.isArray(opts)) {
      // query(sql, vals)
      vals = opts;
      opts = undefined;
    } else if (typeof opts === 'object' && opts !== null) {
      // query(sql, opts)
      if (typeof opts.prepareFlags === 'number')
        prepareFlags = (opts.prepareFlags & PREPARE_FLAGS_MASK);
      if (opts.abortType !== undefined) {
        if (typeof opts.abortType !== 'string'
            || !ABORT_TYPES.has(opts.abortType)) {
          throw new Error(`Invalid abort type: ${opts.abortType}`);
        }
        abortType = opts.abortType;
      }
      if (opts.values !== undefined)
        vals = opts.values;
      if (opts.rowsAsArray === true)
        flags |= QUERY_FLAG_ROWS_AS_ARRAY;
    }
    if (vals && !Array.isArray(vals)) {
      if (typeof vals === 'object' && vals !== null) {
        flags |= QUERY_FLAG_NAMED_PARAMS;
        const keys = Object.keys(vals);
        const valsKV = new Array(keys.length * 2);
        for (let k = 0, p = 0; k < keys.length; ++k, p += 2) {
          const key = keys[k];
          valsKV[p] = `:${key}`;
          valsKV[p + 1] = vals[key];
        }
        vals = valsKV;
      } else {
        throw new TypeError('Invalid query placeholder values type');
      }
    }

    const iter = new StatementIterator(
      abortType, this, sql, prepareFlags, flags, vals
    );
    this[kQueue].push(iter);
    if (!this[kSlot])
      processQueue(this);
    return iter;
  }

  query(sql, opts, vals, cb) {
    if (typeof sql !== 'string')
      throw new TypeError('Invalid sql value');

    let prepareFlags = DEFAULT_PREPARE_FLAGS;
    let flags = QUERY_FLAG_SINGLE;
    if (typeof opts === 'function') {
      // query(sql, cb)
      cb = opts;
      opts = undefined;
      vals = undefined;
    } else if (Array.isArray(opts)) {
      // query(sql, vals, cb)
      cb = vals;
      vals = opts;
      opts = undefined;
    } else if (typeof opts === 'object' && opts !== null) {
      // query(sql, opts, cb)
      if (typeof opts.prepareFlags === 'number')
        prepareFlags = (opts.prepareFlags & PREPARE_FLAGS_MASK);
      if (opts.single === false)
        flags &= ~QUERY_FLAG_SINGLE;
      if (opts.rowsAsArray === true)
        flags |= QUERY_FLAG_ROWS_AS_ARRAY;
      if (typeof vals === 'function') {
        cb = vals;
        vals = undefined;
      }
      if (opts.values !== undefined)
        vals = opts.values;
    }
    if (vals && !Array.isArray(vals)) {
      if (typeof vals === 'object' && vals !== null) {
        flags |= QUERY_FLAG_NAMED_PARAMS;
        const keys = Object.keys(vals);
        const valsKV = new Array(keys.length * 2);
        for (let k = 0, p = 0; k < keys.length; ++k, p += 2) {
          const key = keys[k];
          valsKV[p] = `:${key}`;
          valsKV[p + 1] = vals[key];
        }
        vals = valsKV;
      } else {
        throw new TypeError('Invalid query placeholder values type');
      }
    }

    if (typeof cb !== 'function')
      cb = null;

    this[kQueue].push([sql, prepareFlags, flags, vals, cb]);
    if (!this[kSlot])
      processQueue(this);
  }

  interrupt(cb) {
    this[kHandle].interrupt(() => {
      if (typeof cb === 'function')
        cb();
    });
  }

  autoCommitEnabled() {
    return this[kHandle].autoCommitEnabled();
  }

  end() {
    if (this[kSlot] || this[kQueue].length)
      this[kAutoClose] = true;
    else
      this[kHandle].close();
  }

  close() {
    this[kHandle].close();
  }
}

function makeRowObjFn() {
  let code = 'return {';
  for (let i = 0; i < arguments.length; ++i)
    code += `${JSON.stringify(arguments[i])}:v[idx+${i}],`;
  code += '}';
  const fn = new Function('v,idx', code);
  fn.ncols = arguments.length;
  return fn;
}

function makeRowArrayFn(ncols) {
  let code = 'return [';
  for (let i = 0; i < ncols; ++i)
    code += `v[idx+${i}],`;
  code += ']';
  const fn = new Function('v,idx', code);
  fn.ncols = ncols;
  return fn;
}

function makeRows(pos, rowFn, ...data) {
  const ncols = rowFn.ncols;
  for (let i = 0; i < data.length; i += ncols)
    this[pos++] = rowFn(data, i);
}

function statusCallback(status, lastStmt, data, colCount) {
  const db = (this.db || this);
  db[kBusy] = false;
  const current = db[kSlot];
  if (Array.isArray(current)) {
    // Callback API
    const cb = current[current.length - 1];
    if (cb) {
      const errs = db[kBuffer][0];
      const sets = db[kBuffer][1];
      if (status === QUERY_STATUS_DONE) {
        // Implies `lastStmt === true`
        db[kBuffer][0] = undefined;
        db[kBuffer][1] = undefined;
        if (!sets)
          cb(null);
        else
          cb(errs, sets);
      } else if (status === QUERY_STATUS_COMPLETE) {
        const rows = (data || []);

        if (lastStmt) {
          db[kBuffer][0] = undefined;
          db[kBuffer][1] = undefined;
          if (!sets) {
            cb(null, rows);
          } else {
            errs.push(null);
            sets.push(rows);
            cb(errs, sets);
          }
        } else if (!sets) {
          db[kBuffer][0] = [null];
          db[kBuffer][1] = [rows];
        } else {
          errs.push(null);
          sets.push(rows);
        }
      } else if (status === QUERY_STATUS_ERROR) {
        if (lastStmt) {
          db[kBuffer][0] = undefined;
          db[kBuffer][1] = undefined;
          if (!errs) {
            cb(data);
          } else {
            errs.push(data);
            sets.push(undefined);
            cb(errs, sets);
          }
        } else if (!errs) {
          db[kBuffer][0] = [data];
          db[kBuffer][1] = [undefined];
        } else {
          errs.push(data);
          sets.push(undefined);
        }
      }
    }
    if (!lastStmt)
      return this.query();
  } else if (current[kParent]) {
    // Statement
    const stmt = current;
    if (stmt.colCount === undefined)
      stmt.colCount = colCount;
    if (status === QUERY_STATUS_INCOMPLETE) {
      stmt[kSlot].resolve(data || []);
      stmt[kSlot] = null;
      processQueue(db);
      return;
    }
    stmt[kDone] = true;
    if (status === QUERY_STATUS_DONE) {
      // Implies `lastStmt === true`
      stmt[kSlot].resolve();
      stmt[kSlot] = null;
      for (const entry of stmt[kQueue])
        entry.resolve();
    } else if (status === QUERY_STATUS_COMPLETE) {
      stmt[kSlot].resolve(data);
      stmt[kSlot] = null;
      for (const entry of stmt[kQueue])
        entry.resolve();
    } else if (status === QUERY_STATUS_ERROR) {
      stmt[kError] = data;
      stmt[kSlot].reject(data);
      stmt[kSlot] = null;
      for (const entry of stmt[kQueue])
        entry.reject(data);
    }
    stmt[kQueue] = [];
  } else {
    // Iterator
    const iter = current;
    const stmt = iter[kSlot];
    if (stmt.colCount === undefined)
      stmt.colCount = colCount;
    if (status === QUERY_STATUS_INCOMPLETE) {
      stmt[kSlot].resolve(data || []);
      stmt[kSlot] = null;
      processQueue(db);
      return;
    }
    stmt[kDone] = true;
    if (status === QUERY_STATUS_DONE) {
      // Implies `lastStmt === true`
      stmt[kSlot].resolve();
      stmt[kSlot] = null;
      for (const entry of stmt[kQueue])
        entry.resolve();
    } else if (status === QUERY_STATUS_COMPLETE) {
      stmt[kSlot].resolve(data);
      stmt[kSlot] = null;
      for (const entry of stmt[kQueue])
        entry.resolve();
    } else if (status === QUERY_STATUS_ERROR) {
      stmt[kError] = data;
      stmt[kSlot].reject(data);
      stmt[kSlot] = null;
      for (const entry of stmt[kQueue])
        entry.reject(data);
    }
    stmt[kQueue] = [];
    iter[kSlot] = null;
    if (lastStmt) {
      iter[kQueue] = [];
      iter[kDone] = true;
      db[kSlot] = null;
      for (const entry of iter[kQueue])
        entry.resolve();
    }
    processQueue(db);
    return;
  }
  db[kSlot] = null;
  processQueue(db);
}

module.exports = {
  Database,
  OPEN_FLAGS: { ...OPEN_FLAGS },
  PREPARE_FLAGS: { ...PREPARE_FLAGS },
  ACTION_CODES,
  version: version(),
};

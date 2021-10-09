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

const kPath = Symbol('Database path');
const kHandle = Symbol('Database handle');
const kQueue = Symbol('Database query queue');

class Database {
  constructor(path) {
    if (typeof path !== 'string')
      throw new Error('Invalid path value');
    this[kPath] = path;
    this[kHandle] = new DBHandle(makeRow, makeRowObjFn);
    const queue = [];
    queue.busy = false;
    this[kQueue] = queue;
  }

  open(flags) {
    if (typeof flags !== 'number')
      flags = DEFAULT_OPEN_FLAGS;
    else
      flags &= OPEN_FLAGS_MASK;
    this[kHandle].open(this[kPath], flags);
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
        vals = undefined;
      }
    }

    if (typeof cb !== 'function')
      cb = null;

    const queue = this[kQueue];
    if (queue.busy)
      queue.push([sql, prepareFlags, flags, vals, cb]);
    else
      tryQuery(this, sql, prepareFlags, flags, vals, cb);
  }

  /*
  querySync(sql, opts, vals) {
    if (typeof sql !== 'string')
      throw new TypeError('Invalid sql value');

    let prepareFlags = DEFAULT_PREPARE_FLAGS;
    let flags = QUERY_FLAG_SINGLE;

    if (Array.isArray(opts)) {
      // query(sql, vals)
      vals = opts;
      opts = undefined;
    } else if (typeof opts === 'object' && opts !== null) {
      // query(sql, opts)
      if (typeof opts.prepareFlags === 'number')
        prepareFlags = (opts.prepareFlags & PREPARE_FLAGS_MASK);
      if (opts.single === false)
        flags &= ~QUERY_FLAG_SINGLE;
      if (opts.values !== undefined)
        vals = opts.values;
    }
    if (vals) {
      if (Array.isArray(vals)) {
        ;
      } else if (typeof vals === 'object' && vals !== null) {
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
        vals = undefined;
      }
    }
    const ret = this[kHandle].querySync(sql, prepareFlags, flags, vals);
  }
  */

  interrupt(cb) {
    this[kHandle].interrupt(() => {
      if (typeof cb === 'function')
        cb();
    });
  }

  autoCommitEnabled() {
    return this[kHandle].autoCommitEnabled();
  }

  close(cb) {
    this[kHandle].close();
  }
}

function tryQuery(self, sql, prepareFlags, flags, vals, cb) {
  const queue = self[kQueue];
  try {
    queue.busy = true;
    self[kHandle].query(sql, prepareFlags, flags, vals, (err, results) => {
      if (cb) {
        if (err) {
          cb(err.length === 1 ? err[0] : err,
             results && results.length === 1 ? results[0] : results);
        } else {
          cb(null, results.length === 1 ? results[0] : results);
        }
      }
      if (queue.length) {
        const entry = queue.shift();
        tryQuery(
          self, entry[0], entry[1], entry[2], entry[3], entry[4]
        );
      } else {
        queue.busy = false;
      }
    });
  } catch (ex) {
    if (queue.length) {
      const entry = queue.shift();
      process.nextTick(
        tryQuery, self, entry[0], entry[1], entry[2], entry[3], entry[4]
      );
    } else {
      queue.busy = false;
    }
    if (cb)
      cb(ex);
  }
}

function makeRowObjFn() {
  let code = 'return {';
  for (let i = 0; i < arguments.length; ++i)
    code += `${JSON.stringify(arguments[i])}:v[${i}],`;
  return new Function('v', code + '}');
}

function makeRow(pos, rowFn, ...data) {
  this[pos] = rowFn(data);
}

module.exports = {
  Database,
  OPEN_FLAGS: { ...OPEN_FLAGS },
  PREPARE_FLAGS: { ...PREPARE_FLAGS },
  version: version(),
};

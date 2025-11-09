#!/usr/bin/env node
'use strict';

const { Console } = require('console');
const { readFileSync } = require('fs');
const { basename, join } = require('path');
const { createInterface } = require('readline');
const { Writable } = require('stream');
const { StringDecoder } = require('string_decoder');

const { Database, OPEN_FLAGS } = require(join(__dirname, '..'));

const writeTable = (input) => {
  return new Promise((resolve, reject) => {
    let out = '';
    const sd = new StringDecoder('utf8');
    const ws = new Writable({
      write(chunk, enc, cb) {
        out += sd.write(chunk);
        cb();
      },
      final(cb) {
        out += sd.end();
        cb();
      },
    });
    ws.on('error', (err) => reject(err));
    ws.once('close', () => {
      let result = '';
      for (const row of out.split(/[\r\n]+/)) {
        let r = row.replace(/[^┬]*┬/, '┌');
        r = r.replace(/^├─*┼/, '├');
        r = r.replace(/│[^│]*/, '');
        r = r.replace(/^└─*┴/, '└');
        r = r.replace(/'/g, ' ');
        result += `${r}\n`;
      }
      process.stdout.write(result);
      resolve();
    });
    (new Console({ stdout: ws, colorMode: true })).table(input);
    ws.end();
  });
};

const convertDuration = (val) => {
  let msecs = val / 1000000n;
  let secs = (msecs / 1000n);
  msecs = (msecs % 1000n).toString().padStart(2, '0');
  const mins = (secs / 60n).toString().padStart(2, '0');
  secs = (secs % 60n).toString().padStart(2, '0');
  return `${mins}m:${secs}s:${msecs}ms`;
};

const argv = process.argv;
let filename;
let openFlags;

for (let i = 2; i < argv.length; ++i) {
  const arg = argv[i];
  if (arg[0] === '-') {
    switch (arg.slice(1)) {
      case 'r':
        openFlags = OPEN_FLAGS.READONLY;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  } else {
    filename = arg;
    break;
  }
}
if (!filename)
  filename = ':memory:';

const version = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
).version;

const db = new Database(filename);
db.open(openFlags);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  tabSize: 2,
});

const queryOpts = { rowsAsArray: true };
(async () => {
  const sigintHandler = () => {
    db.interrupt(() => {});
  };
  let source;
  if (filename.toLowerCase() === ':memory:')
    source = 'In-memory database';
  else
    source = `Database: ${basename(filename)}`;
  console.log(`esqlite ${version} CLI; To exit type ".exit"; ${source}`);
  rl.prompt();

  readline_loop:
  for await (let line of rl) {
    rl.once('SIGINT', sigintHandler);

    line_proc:
    try {
      switch (line) {
        case '.databases':
          line = 'SELECT name, file FROM pragma_database_list';
          break;
        case '.tables': {
          let sql = '';
          const databases = await db.queryAsync(
            'SELECT name FROM pragma_database_list',
            queryOpts
          ).execute();
          if (!databases || !databases.length)
            break line_proc;
          for (const [ name ] of databases) {
            if (!name)
              continue;
            if (sql)
              sql += ' UNION ALL ';
            if (name.toLowerCase() === 'main')
              sql += 'SELECT name FROM ';
            else
              sql += `SELECT '${name.replace(/'/g, `''`)}'||'.'||name FROM `;
            sql += `"${name.replace(/"/g, '""')}".sqlite_schema `;
            sql += `WHERE type IN ('table', 'view')`;
            sql += `  AND name NOT LIKE 'sqlite__%' ESCAPE '_'`;
          }
          if (sql) {
            sql += ' ORDER BY 1';
            line = sql;
          } else {
            break line_proc;
          }
          break;
        }
        case '.exit':
          break readline_loop;
      }

      let time = process.hrtime.bigint();
      const rows = await db.queryAsync(line).execute();
      time = convertDuration(process.hrtime.bigint() - time);

      if (!rows || rows.length === 0) {
        console.log(`0 rows in set (${time})`);
      } else {
        try {
          await writeTable(rows);
          const s = (rows.length > 1 ? 's' : '');
          console.log(`${rows.length} row${s} in set (${time})`);
        } catch (ex) {
          console.error(`Render Error: ${ex.message}`);
        }
      }
    } catch (ex) {
      console.error(`Query Error: ${ex.message}`);
    }

    rl.removeListener('SIGINT', sigintHandler);

    rl.prompt();
  }
  db.close();
  rl.close();
})();

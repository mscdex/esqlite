'use strict';

const BuildEnvironment = require('buildcheck');

const be = new BuildEnvironment();

const gyp = {
  defines: [],
  libraries: [],
};

[
  'inttypes.h',
  'malloc.h',
  'memory.h',
  'stdint.h',
  'stdlib.h',
  'string.h',
  'strings.h',
  'sys/types.h',
  'sys/stat.h',
  'unistd.h',
].forEach((headerName) => {
  be.checkHeader('c', headerName);
});

// On Windows localtime_s is a macro, so we need to use `checkDeclared()`
[
  ['localtime_s', { headers: ['time.h'] }],
].forEach((fnName) => {
  if (Array.isArray(fnName))
    be.checkDeclared('c', ...fnName);
  else
    be.checkDeclared('c', fnName);
});

[
  ['fdatasync', { searchLibs: ['rt'] }],
  'gmtime_r',
  'isnan',
  'localtime_r',
  'malloc_usable_size',
  'posix_fallocate',
  'pread',
  'pread64',
  'pwrite',
  'pwrite64',
  'strchrnul',
  'usleep',
  'utime',
].forEach((fnName) => {
  if (Array.isArray(fnName))
    be.checkFunction('c', ...fnName);
  else
    be.checkFunction('c', fnName);
});

[
  'strerror_r',
].forEach((feat) => {
  be.checkFeature(feat);
});

// Custom defines --------------------------------------------------------------
gyp.defines.push(
  'SQLITE_ENABLE_FTS3',
  'SQLITE_ENABLE_JSON1',
);

if (be.checkFunction('c', 'log', { searchLibs: ['m'] }))
  gyp.defines.push('SQLITE_ENABLE_FTS4', 'SQLITE_ENABLE_FTS5');

if (be.checkFunction('c', 'ceil', { searchLibs: ['m'] }))
  gyp.defines.push('SQLITE_ENABLE_MATH_FUNCTIONS');
// -----------------------------------------------------------------------------

// Add the things we detected
gyp.defines.push(...be.defines(null, true));
gyp.libraries.push(...be.libs());

console.log(JSON.stringify(gyp, null, 2));

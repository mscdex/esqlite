{
  'targets': [
    {
      'target_name': 'esqlite3',
      'dependencies': [ 'deps/sqlite3/sqlite3.gyp:sqlite3mc' ],
      'include_dirs': [
        'src',
        "<!(node -e \"require('nan')\")",
      ],
      'sources': [
        'src/binding.cc'
      ],
      'cflags': [ '-O3' ],
      'conditions': [
        ['OS=="linux"', {
          'ldflags': [
            '-Wl,-Bsymbolic',
            '-Wl,--exclude-libs,ALL',
          ],
        }],
        ['OS=="win"', {
          'win_delay_load_hook': 'false',
        }],
      ],
    },
  ],
}

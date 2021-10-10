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
          'msvs_settings': {
            # These settings from node-gyp need to be reverted because LTCG
            # prevents /OPT:NOREF and /OPT:NOREF is needed because we use a V8
            # class that has virtual data, which causes a linker error without
            # the flag.
            'VCCLCompilerTool': {
              'WholeProgramOptimization': 'false',
            },
            'VCLibrarianTool': {
              'AdditionalOptions!': [
                '/LTCG:INCREMENTAL',
              ],
              'AdditionalOptions': [
                '/OPT:NOREF',
              ],
            },
            'VCLinkerTool': {
              'OptimizeReferences': 1, # /OPT:NOREF
              'AdditionalOptions!': [
                '/LTCG:INCREMENTAL',
              ],
              'AdditionalOptions': [
                # Unfortunately this flag keeps _all_ unused functions and data.
                # We could instead use '/INCLUDE:<symbol>' but it appears the
                # decorated symbol name changes across node versions which would
                # be a pain to maintain here...
                '/OPT:NOREF',
              ],
            },
          },
        }],
      ],
    },
  ],
}

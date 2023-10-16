{
  'targets': [
    {
      'target_name': 'sqlite3mc',
      'type': 'static_library',
      'sources': [
        'sqlite3mc_amalgamation.c',
      ],
      'cflags': [ '-O3' ],
      'defines': [
        # General defines for SQLite
        '_REENTRANT=1',
        'SQLITE_DEFAULT_CACHE_SIZE=-16000',
        'SQLITE_DQS=0',
        'SQLITE_LIKE_DOESNT_MATCH_BLOBS',
        'SQLITE_DEFAULT_MEMSTATUS=0',
        'SQLITE_OMIT_AUTHORIZATION',
        'SQLITE_OMIT_AUTOINIT',
        'SQLITE_OMIT_AUTORESET',
        'SQLITE_OMIT_COMPLETE',
        'SQLITE_OMIT_DEPRECATED',
        'SQLITE_OMIT_GET_TABLE',
        'SQLITE_OMIT_PROGRESS_CALLBACK',
        'SQLITE_OMIT_SHARED_CACHE',
        'SQLITE_OMIT_TCL_VARIABLE',
        'SQLITE_OMIT_TRACE',
        'SQLITE_THREADSAFE=2',
        'SQLITE_TRACE_SIZE_LIMIT=32',
        'SQLITE_UNTESTABLE',
        'SQLITE_USE_URI=0',

        # Defines from/for SQLite3MultipleCiphers
        'CODEC_TYPE=CODEC_TYPE_CHACHA20',
        'HAVE_CIPHER_CHACHA20=1',
        'HAVE_CIPHER_AES_128_CBC=0',
        'HAVE_CIPHER_AES_256_CBC=0',
        'HAVE_CIPHER_SQLCIPHER=0',
        'HAVE_CIPHER_RC4=0',
        'SQLITE_CORE=1',
        'SQLITE_ENABLE_CSV=1',
        'SQLITE_ENABLE_EXTFUNC=1',
        'SQLITE_ENABLE_REGEXP=1',
        'SQLITE_ENABLE_SERIES=1',
        'SQLITE_ENABLE_UUID=1',
        'SQLITE_SECURE_DELETE=1',
        'SQLITE_TEMP_STORE=2',
        'SQLITE_USER_AUTHENTICATION=0',
      ],

      # System-specific and feature configs for SQLite
      # Use generated config
      'includes': [
        '../../buildcheck.gypi',
      ],
      'conditions': [
        [ 'OS != "win"', {
          # SQLite3MultipleCiphers and SQLite3 can be very noisy, mostly due to
          # unused functions and variables
          'cflags': [ '-w' ],
          'xcode_settings': {
            'WARNING_CFLAGS': [
              '-w',
            ],
          },
        }],
      ],

      'direct_dependent_settings': {
        'include_dirs': ['.'],
        'defines': [
          # Manually-tracked custom git revision
          'SQLITE3MC_VERSION_REV=1b8d7d13cf96011f726a3a82e116c12f89a2784a',
        ],
      },
    },
  ],
}

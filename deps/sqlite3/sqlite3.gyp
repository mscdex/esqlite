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

        # Feature defines for SQLite
        'SQLITE_ENABLE_FTS3',
        'SQLITE_ENABLE_FTS4',
        'SQLITE_ENABLE_FTS5',
        'SQLITE_ENABLE_JSON1',
        'SQLITE_ENABLE_MATH_FUNCTIONS',
      ],

      # System-specific defines for SQLite
      # TODO: get these defines dynamically
      'conditions': [
        [ 'OS != "win"', {
          # SQLite3MultipleCiphers and SQLite3 can be very noisy, mostly due to
          # unused functions and variables
          'cflags': [ '-w' ],

          'defines': [
            'HAVE_FDATASYNC=1',
            'HAVE_GMTIME_R=1',
            'HAVE_INTTYPES_H=1',
            'HAVE_ISNAN=1',
            'HAVE_LOCALTIME_R=1',
            'HAVE_MALLOC_H=1',
            'HAVE_MALLOC_USABLE_SIZE=1',
            'HAVE_MEMORY_H=1',
            'HAVE_POSIX_FALLOCATE=1',
            'HAVE_PREAD=1',
            'HAVE_PREAD64=1',
            'HAVE_PWRITE=1',
            'HAVE_PWRITE64=1',
            'HAVE_STDINT_H=1',
            'HAVE_STDLIB_H=1',
            'HAVE_STRCHRNUL=1',
            'HAVE_STRERROR_R=1',
            'HAVE_STRING_H=1',
            'HAVE_STRINGS_H=1',
            'HAVE_SYS_TYPES_H=1',
            'HAVE_SYS_STAT_H=1',
            'HAVE_UNISTD_H=1',
            'HAVE_USLEEP=1',
            'HAVE_UTIME=1',
          ],
        }],
        [ 'OS == "mac"', {
          'defines!': [
            'HAVE_POSIX_FALLOCATE=1',
            'HAVE_PREAD64=1',
            'HAVE_PWRITE64=1',
            'HAVE_STRCHRNUL=1',
          ],
          'defines': [
            'HAVE_FULLFSYNC=1',
          ],
        }],
        [ 'OS=="win"', {
          'defines': [
            'HAVE_LOCALTIME_S=1',
          ],
        }],
      ],

      'direct_dependent_settings': {
        'include_dirs': ['.'],
        'defines': [
          # Manually-tracked custom git revision
          'SQLITE3MC_VERSION_REV=e89ac7c9f7b9ff225a1b342b058aff81378d72f3',
        ],
      },
    },
  ],
}

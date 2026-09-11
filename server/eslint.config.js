import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['coverage/**', 'src/generated/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Services run on both HTTP and worker paths: no request/response objects,
    // no queue or socket modules. Violations break worker reuse.
    files: ['src/services/**/*.js', 'src/lib/sequence.js', 'src/lib/idempotency.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'express', message: 'Services must not import HTTP framework code.' },
            { name: 'bullmq', message: 'Services must not import queue code; enqueue after commit.' },
            { name: 'socket.io', message: 'Services must not import socket code; publish after commit.' },
            { name: 'redis', message: 'Services must not import cache code.' },
          ],
          patterns: [
            {
              group: ['**/queue/**', '**/realtime/**', '**/tracking/**'],
              message: 'Services must not reach queue, realtime, or tracking modules.',
            },
          ],
        },
      ],
    },
  },
]

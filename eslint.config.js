import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@stylistic/padding-line-between-statements': [
        'error',
        // Keep multi-line control-flow and object-method blocks visually separate.
        { blankLine: 'always', prev: 'block-like', next: '*' },

        // A return should stand on its own so the exit path is easy to scan.
        { blankLine: 'always', prev: '*', next: 'return' },

        // Allow grouped declarations, but add breathing room before the next kind
        // of statement so setup and behavior do not blur together.
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        {
          blankLine: 'any',
          prev: ['const', 'let', 'var'],
          next: ['const', 'let', 'var'],
        },
      ],
    },
  },
];

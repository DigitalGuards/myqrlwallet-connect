import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { fileURLToPath } from 'node:url';
import { doubleAssertionGuard, hardenedRules } from '../scripts/eslint-policy.mjs';

const typedFiles = ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'];
// Match the complete file selection used by npm run lint.
export const strictFiles = ['.'];

export const baseConfig = [
  { ignores: ['dist/', 'node_modules/'] },
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...[
    ...tsPlugin.configs['flat/strict-type-checked'],
    ...tsPlugin.configs['flat/stylistic-type-checked'],
    prettier,
  ].map((config) => ({ ...config, files: typedFiles })),
  {
    files: typedFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
    },
    rules: {
      ...hardenedRules,
      // Preserve the legacy unused-binding options, including caught errors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@noble/*', '@theqrl/*'],
              message: 'Crypto implementations do not belong in the UI package.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        doubleAssertionGuard,
        {
          selector: 'MemberExpression[property.name="subtle"]',
          message: 'WebCrypto does not belong in the UI package.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
  {
    files: ['*.mjs', 'vitest.config.ts'],
    languageOptions: { globals: globals.node },
  },
];

// Existing lint debt, including tests. Entries may only be removed.
// Regenerate with npm run lint:ratchet:update after fixing a file/rule pair.
// BEGIN LINT RATCHET
export const lintRatchet = [
  {
    files: ['test/element.test.ts'],
    rules: { '@typescript-eslint/consistent-type-assertions': 'off' },
  },
];
// END LINT RATCHET

export default [...baseConfig, ...lintRatchet];

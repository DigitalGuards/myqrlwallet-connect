import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { fileURLToPath } from 'node:url';
import { doubleAssertionGuard, hardenedRules } from './scripts/eslint-policy.mjs';

const typedFiles = ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'];
// Match the complete file selection used by npm run lint.
export const strictFiles = ['src', 'test', 'scripts', '*.mjs', 'vitest.config.ts'];

export const baseConfig = [
  { ignores: ['dist/', 'node_modules/', 'example/'] },
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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', doubleAssertionGuard],
    },
  },
  {
    files: ['src/**/*.ts', 'example/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/crypto/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@noble/*', '@theqrl/*'],
              message:
                'Crypto implementations may only be imported inside src/crypto/ (the primitive boundary).',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        doubleAssertionGuard,
        {
          selector: 'MemberExpression[property.name="subtle"]',
          message: 'WebCrypto SubtleCrypto may only be used inside src/crypto/.',
        },
        {
          selector: 'MemberExpression[property.name="getRandomValues"]',
          message: 'CSPRNG access may only happen inside src/crypto/ (randomBytes).',
        },
        {
          selector: 'MemberExpression[property.name="randomUUID"]',
          message:
            'Use randomUuid() from src/crypto/ so all randomness flows through the boundary.',
        },
        {
          selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
          message: 'Math.random is forbidden in this SDK; use randomBytes() from src/crypto/.',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'src/**/__tests__/**/*.ts', 'example/*.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
  {
    // These are compatibility tests for the deprecated verifier wrappers.
    files: ['src/signing/__tests__/parity.test.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': [
        'error',
        {
          allow: [
            {
              from: 'file',
              name: ['verifyMessage', 'verifyTypedData'],
              path: 'src/signing/verify.ts',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['example/*.js', 'test-e2e.mjs'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['*.mjs', 'scripts/**/*.mjs', 'vitest.config.ts', 'example/vite.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // All SDK console output flows through this boundary.
    files: ['src/utils/logger.ts'],
    rules: { 'no-console': 'off' },
  },
];

// Existing lint debt, including tests. Entries may only be removed.
// Regenerate with npm run lint:ratchet:update after fixing a file/rule pair.
// BEGIN LINT RATCHET
export const lintRatchet = [
  {
    files: ['src/ConnectionManager.ts'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off', 'preserve-caught-error': 'off' },
  },
  {
    files: ['src/KeyExchange.ts'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off' },
  },
  {
    files: ['src/QRLConnectProvider.ts'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off', 'preserve-caught-error': 'off' },
  },
  {
    files: ['src/SessionOwnership.ts'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off' },
  },
  {
    files: ['src/SocketClient.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    files: ['src/crypto/primitives.ts'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off' },
  },
  {
    files: ['src/signing/__tests__/parity.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
    },
  },
  {
    files: ['src/signing/__tests__/schemeParity.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/signing/__tests__/typedDataSecurity.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/signing/typedData.ts'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off' },
  },
  { files: ['src/utils/qrUri.ts'], rules: { 'preserve-caught-error': 'off' } },
  { files: ['test-e2e.mjs'], rules: { 'no-console': 'off', 'no-empty': 'off' } },
  {
    files: ['test/ConnectionManager.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['test/KeyExchange.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['test/QRLConnectProvider.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['test/SessionOwnership.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['test/SocketClient.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
    },
  },
  {
    files: ['test/config.test.ts'],
    rules: { '@typescript-eslint/consistent-type-assertions': 'off' },
  },
  { files: ['test/kat.test.ts'], rules: { '@typescript-eslint/no-unnecessary-condition': 'off' } },
  { files: ['test/logger.test.ts'], rules: { '@typescript-eslint/no-empty-function': 'off' } },
  { files: ['test/setup.ts'], rules: { 'no-console': 'off' } },
];
// END LINT RATCHET

export default [...baseConfig, ...lintRatchet];

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/strict-type-checked',
    'plugin:@typescript-eslint/stylistic-type-checked',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'off',

    // ── No type laundering (mandate) ──────────────────────────
    // The compiler's view of a value must never be widened or rewritten by
    // hand. Wire input gets runtime guards, not assertions.
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    '@typescript-eslint/ban-ts-comment': [
      'error',
      {
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-expect-error': 'allow-with-description',
        minimumDescriptionLength: 10,
      },
    ],

    // Defensive runtime validation of typed parameters is deliberate in a
    // public SDK consumed from plain JS; don't flag those checks as dead.
    '@typescript-eslint/no-unnecessary-condition': 'off',

    // Byte lengths and counters in error messages are idiomatic; only
    // ban the genuinely lossy stringifications.
    '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
  },
  overrides: [
    {
      // ── Crypto primitive fence (mandate) ──────────────────
      // Only src/crypto/ may import a crypto implementation or touch the
      // platform crypto object. Everything else composes protocol logic on
      // top of that boundary.
      files: ['src/**/*.ts'],
      excludedFiles: ['src/crypto/**'],
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
      // Tests exercise malformed input and mock internals; assertions are a
      // legitimate tool there. The production fence above stays intact.
      files: ['test/**/*.ts', 'src/**/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/consistent-type-assertions': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/unbound-method': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-unsafe-function-type': 'off',
        '@typescript-eslint/restrict-plus-operands': 'off',
        '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'example/'],
};

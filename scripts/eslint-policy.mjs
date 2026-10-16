// Shared hardening for the browser SDK and its web component.
export const doubleAssertionGuard = {
  selector: 'TSAsExpression > TSAsExpression',
  message: 'Double type assertions are banned. Narrow unknown input with a guard.',
};

export const hardenedRules = {
  // ESLint 8 recommended enforced both rules with these options. Keep that
  // coverage through the flat-config migration and ESLint's changed defaults.
  'no-inner-declarations': ['error', 'functions', { blockScopedFunctions: 'disallow' }],
  'no-constant-condition': ['error', { checkLoops: true }],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
  '@typescript-eslint/consistent-type-imports': [
    'error',
    {
      prefer: 'type-imports',
      fixStyle: 'separate-type-imports',
      disallowTypeAnnotations: false,
    },
  ],
  '@typescript-eslint/ban-ts-comment': [
    'error',
    { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true },
  ],
  '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
  'no-console': 'error',
};

// These are the rules the legacy configs left disabled in their test overrides.
// All other existing rules remain enforced on every file, including tests.
const testExemptions = [
  'consistent-type-assertions',
  'no-explicit-any',
  'no-non-null-assertion',
  'no-unsafe-assignment',
  'no-unsafe-member-access',
  'no-unsafe-call',
  'no-unsafe-argument',
  'no-unsafe-return',
  'unbound-method',
  'no-empty-function',
  'no-floating-promises',
];
const coreTestExemptions = [
  ...testExemptions,
  'no-unsafe-function-type',
  'restrict-plus-operands',
  'use-unknown-in-catch-callback-variable',
];

export function canRatchet(file, rule, ui = false) {
  // The legacy lint command covered TypeScript only. The E2E harness now
  // receives the recommended JavaScript rules and the console boundary.
  if (!ui && file === 'test-e2e.mjs' && rule === 'no-empty') return true;
  if (['no-restricted-imports', 'no-restricted-globals'].includes(rule)) return false;
  if (rule === 'no-restricted-syntax') {
    // Core test/ had no syntax fence. Co-located tests and UI retain theirs.
    return !ui && file.startsWith('test/');
  }
  if (
    [
      'no-console',
      'preserve-caught-error',
      '@typescript-eslint/no-unnecessary-condition',
      '@typescript-eslint/consistent-type-imports',
    ].includes(rule)
  ) {
    return true;
  }
  const test = file.startsWith('test/') || (!ui && file.includes('/__tests__/'));
  return (
    test &&
    (ui ? testExemptions : coreTestExemptions).some((name) => rule === `@typescript-eslint/${name}`)
  );
}

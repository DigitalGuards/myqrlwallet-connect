/**
 * Vitest global setup: silence the SDK's tagged console output during tests.
 *
 * Failure-path tests deliberately drive logError/logWarn ("Failed to join
 * channel: Channel is full", "Rejoin failed: ..."), and vitest surfaces those
 * as `stderr |` blocks that make a fully passing suite read like failures in
 * CI/publish output. Filter ONLY messages carrying the SDK's `[QRLConnect:`
 * tag so genuinely unexpected console noise still shows.
 *
 * logger.test.ts is unaffected: it installs its own vi.spyOn(...).mockImplementation
 * per test (recording calls before they reach these wrappers) and restores
 * back to them afterwards.
 */
const isSdkTagged = (args: unknown[]): boolean =>
  typeof args[0] === 'string' && args[0].startsWith('[QRLConnect:');

const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);

console.warn = (...args: unknown[]): void => {
  if (isSdkTagged(args)) return;
  realWarn(...args);
};

console.error = (...args: unknown[]): void => {
  if (isSdkTagged(args)) return;
  realError(...args);
};

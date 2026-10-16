/**
 * Vitest global setup: silence the SDK's tagged console output during tests.
 *
 * Failure-path tests deliberately drive logError/logWarn ("Failed to join
 * channel: Channel is full", "Rejoin failed: ..."), and vitest surfaces those
 * as `stderr |` blocks that make a fully passing suite read like failures in
 * CI/publish output. Filter ONLY messages carrying the SDK's `[QRLConnect:`
 * tag so unexpected console noise still shows.
 *
 * logger.test.ts installs its own vi.spyOn(...).mockImplementation per test,
 * recording calls in place of these filters. Vitest isolates each test file.
 */
import { vi } from 'vitest';

const isSdkTagged = (args: unknown[]): boolean =>
  typeof args[0] === 'string' && args[0].startsWith('[QRLConnect:');

const { warn: realWarn, error: realError } = console;

vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]): void => {
  if (isSdkTagged(args)) return;
  realWarn.apply(console, args);
});

vi.spyOn(console, 'error').mockImplementation((...args: unknown[]): void => {
  if (isSdkTagged(args)) return;
  realError.apply(console, args);
});

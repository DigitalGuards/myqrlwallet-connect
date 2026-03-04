let debugEnabled = false;

export function setDebug(enabled: boolean) {
  debugEnabled = enabled;
}

export function log(tag: string, ...args: unknown[]) {
  if (debugEnabled) {
    console.log(`[QRLConnect:${tag}]`, ...args);
  }
}

export function warn(tag: string, ...args: unknown[]) {
  console.warn(`[QRLConnect:${tag}]`, ...args);
}

export function error(tag: string, ...args: unknown[]) {
  console.error(`[QRLConnect:${tag}]`, ...args);
}

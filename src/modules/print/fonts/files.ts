import { readFileSync } from 'node:fs';

/**
 * One of the label's font files (./files), by name. On the server they are read from disk; the demo pages' browser
 * bundles carry them inside (src/demo/serverOnly.ts swaps this module for one that does).
 */
export function fontFile(name: string): Uint8Array {
  if (!/^[a-z]+-\d{3}i?\.(ttf|kern\.json)$/.test(name)) throw new Error(`No label font called ${name}.`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a name checked just above, from a fixed set of files beside this module
  return readFileSync(new URL(`./files/${name}`, import.meta.url));
}

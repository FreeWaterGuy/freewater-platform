import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The AR viewer is written in TypeScript and uses three.js; it's bundled into one file the first time a phone asks
// for it, then kept. Only phones that open AR download it.
let bundle: Promise<string> | null = null;
export function arBundle(): Promise<string> {
  bundle ??= build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'viewer.ts')],
    bundle: true, format: 'iife', minify: true, write: false, target: ['es2020', 'safari15'], legalComments: 'none',
  }).then((r) => r.outputFiles[0]!.text).catch((e) => { bundle = null; throw e; });
  return bundle;
}

import { readdirSync, readFileSync } from 'node:fs';

// The demo pages' browser bundles reach code that only runs on the server (ids from node:crypto, photos through sharp);
// the pages never call it, so in the bundle those modules are a harmless stand-in (randomUUID uses the browser's own).
// The label's fonts (src/modules/print/fonts/files.ts) are read from disk on the server; in a bundle they travel inside
// it, so the pages measure and outline words exactly as the server does.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- files listed from the repository's own font folder
const readFont = (u: URL) => readFileSync(u).toString('base64');
export const serverOnly = { name: 'server-only', setup(b: any) {
  b.onResolve({ filter: /^\.\/files$/ }, (a: any) => (/print[\\/]fonts[\\/]index\.ts$/.test(a.importer) ? { path: 'label-fonts', namespace: 'label-fonts' } : undefined));
  b.onLoad({ filter: /.*/, namespace: 'label-fonts' }, () => {
    const dir = new URL('../modules/print/fonts/files/', import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the repository's own font folder, at build time
    const files = Object.fromEntries(readdirSync(dir).filter((n) => /\.(ttf|kern\.json)$/.test(n)).map((n) => [n, readFont(new URL(n, dir))]));
    return { loader: 'js', contents: `const F = ${JSON.stringify(files)}; export function fontFile(n) { const s = atob(F[n]); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }` };
  });
  b.onResolve({ filter: /^(node:.*|sharp|detect-libc)$/ }, (a: any) => ({ path: a.path, namespace: 'server-only' }));
  b.onLoad({ filter: /.*/, namespace: 'server-only' }, () => ({ loader: 'js', contents: 'const f = function () { return p; }; const p = new Proxy(f, { get: (_t, k) => (k === "__esModule" ? false : k === "randomUUID" ? () => globalThis.crypto.randomUUID() : p), apply: () => p }); module.exports = p;' }));
} };

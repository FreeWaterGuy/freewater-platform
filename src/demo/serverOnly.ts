// The demo pages' browser bundles reach code that only runs on the server (ids from node:crypto, photos through sharp);
// the pages never call it, so in the bundle those modules are a harmless stand-in (randomUUID uses the browser's own).
export const serverOnly = { name: 'server-only', setup(b: any) {
  b.onResolve({ filter: /^(node:.*|sharp|detect-libc)$/ }, (a: any) => ({ path: a.path, namespace: 'server-only' }));
  b.onLoad({ filter: /.*/, namespace: 'server-only' }, () => ({ loader: 'js', contents: 'const f = function () { return p; }; const p = new Proxy(f, { get: (_t, k) => (k === "__esModule" ? false : k === "randomUUID" ? () => globalThis.crypto.randomUUID() : p), apply: () => p }); module.exports = p;' }));
} };

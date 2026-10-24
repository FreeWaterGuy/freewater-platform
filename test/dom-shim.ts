// A tiny stand-in for a browser, enough to run the platform's plain-JavaScript pages (src/web/*.js) in a test and read
// what they put on screen: the text, the attributes and the inline styles. Not a real browser (no layout, no CSS): the
// pages' fixtures hook (window.__FW_*_FIXTURE__) answers their API calls from the real server.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

class Node0 {
  childNodes: Node0[] = [];
  parentNode: Node0 | null = null;
  nodeType = 1;
  get firstChild(): Node0 | null { return this.childNodes[0] ?? null; }
  get lastChild(): Node0 | null { return this.childNodes.at(-1) ?? null; }
  get children(): any[] { return this.childNodes.filter((c) => c.nodeType === 1); }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.childNodes = []; if (v !== '' && v != null) this.append(new Text0(String(v))); }
  append(...ns: any[]) { for (const n of ns) { const node = typeof n === 'object' && n ? n : new Text0(String(n)); node.parentNode?.removeChild?.(node); node.parentNode = this; this.childNodes.push(node); } }
  appendChild(n: Node0) { this.append(n); return n; }
  prepend(...ns: any[]) { const old = this.childNodes; this.childNodes = []; this.append(...ns); this.childNodes.push(...old); }
  removeChild(n: Node0) { this.childNodes = this.childNodes.filter((c) => c !== n); n.parentNode = null; return n; }
  replaceChildren(...ns: any[]) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...ns); }
  replaceWith(...ns: any[]) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); const tmp = new Node0(); tmp.append(...ns); p.childNodes.splice(i, 1, ...tmp.childNodes); for (const c of tmp.childNodes) c.parentNode = p; }
  remove() { this.parentNode?.removeChild(this); }
  insertBefore(n: Node0, ref: Node0 | null) { n.parentNode?.removeChild(n); const i = ref ? this.childNodes.indexOf(ref) : -1; n.parentNode = this; if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n); return n; }
  contains(n: Node0 | null): boolean { return !!n && (n === this || this.childNodes.some((c) => c.contains(n))); }
}
class Text0 extends Node0 {
  constructor(public data: string) { super(); this.nodeType = 3; }
  override get textContent() { return this.data; }
  override set textContent(v: string) { this.data = v; }
}
const noop = () => {};
class Element0 extends Node0 {
  attributes = new Map<string, string>();
  listeners = new Map<string, Function[]>();
  style: any = new Proxy({ setProperty(k: string, v: string) { (this as any)[k] = v; }, removeProperty: noop, cssText: '' }, {});
  dataset: Record<string, string> = {};
  hidden = false; disabled = false; checked = false; value = ''; files = null; type = ''; id = '';
  constructor(public tagName: string) { super(); }
  get className() { return this.attributes.get('class') ?? ''; }
  set className(v: string) { this.attributes.set('class', v); }
  classList = { add: (...c: string[]) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); this.className = [...s].join(' '); }, remove: (...c: string[]) => { this.className = this.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); }, toggle: (c: string, on?: boolean) => { const has = this.className.split(/\s+/).includes(c); if (on ?? !has) this.classList.add(c); else this.classList.remove(c); return on ?? !has; }, contains: (c: string) => this.className.split(/\s+/).includes(c) };
  setAttribute(k: string, v: string) { this.attributes.set(k, String(v)); if (k === 'id') this.id = String(v); if (k === 'style') this.style.cssText = String(v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  removeAttribute(k: string) { this.attributes.delete(k); }
  hasAttribute(k: string) { return this.attributes.has(k); }
  addEventListener(t: string, f: Function) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  focus() {} blur() {} click() { for (const f of this.listeners.get('click') ?? []) f({ preventDefault: noop, stopPropagation: noop, target: this }); }
  select() {} scrollIntoView() {} setSelectionRange() {} play() { return Promise.resolve(); } pause() {} load() {} showModal() {} close() {} reset() {} requestSubmit() {}
  getBoundingClientRect() { return { x: 0, y: 0, width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300 }; }
  getContext() { return null; }
  querySelector(_s: string): Element0 | null { return null; }
  querySelectorAll(_s: string): Element0[] { return []; }
  closest() { return null; }
  get innerHTML() { return ''; }
  set innerHTML(_v: string) { this.childNodes = []; }
  get offsetWidth() { return 400; } get clientWidth() { return 400; }
}

/** Every piece of text and every attribute value under a node, in order (what a person or a screen reader would get). */
export function allText(n: Node0): string {
  if (n.nodeType === 3) return (n as Text0).data;
  const e = n as Element0;
  const attrs = [...(e.attributes?.values?.() ?? [])].join(' ');
  return `${attrs} ${e.style?.cssText ?? ''} ${n.childNodes.map(allText).join(' ')}`;
}

export interface Page { root: Element0; body: Element0; document: any; text: () => string; title: () => string }

/**
 * Run one of the web pages with its fixture hook. `fixture` is put on window under `fixtureName`; `rootId` is the
 * element the page draws into. Resolves once the page stops changing (a few rounds of timers and promises).
 */
export async function runPage(file: string, opts: { fixtureName: string; fixture: unknown; rootId: string; path?: string; search?: string }): Promise<Page> {
  const body = new Element0('body');
  const root = new Element0('div'); root.setAttribute('id', opts.rootId); body.append(root);
  let title = '';
  const document: any = {
    body, documentElement: new Element0('html'), get title() { return title; }, set title(v: string) { title = v; },
    createElement: (t: string) => new Element0(t), createElementNS: (_ns: string, t: string) => new Element0(t), createTextNode: (t: string) => new Text0(t),
    getElementById: (id: string) => (id === opts.rootId ? root : null), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', head: new Element0('head'),
  };
  const storage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) }; };
  const location = { pathname: opts.path ?? '/', search: opts.search ?? '', origin: 'https://test.example', href: `https://test.example${opts.path ?? '/'}${opts.search ?? ''}`, host: 'test.example', hostname: 'test.example', protocol: 'https:', assign: noop, replace: noop, reload: noop };
  const window: any = {
    [opts.fixtureName]: opts.fixture, document, location, history: { pushState: noop, replaceState: noop, back: noop }, navigator: { userAgent: 'test', clipboard: { writeText: async () => {} }, share: undefined, mediaDevices: undefined },
    localStorage: storage(), sessionStorage: storage(), addEventListener: noop, removeEventListener: noop, scrollTo: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), parent: null,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: (f: Function) => setTimeout(f, 0), cancelAnimationFrame: noop, crypto: webcrypto, btoa, atob, URL, URLSearchParams, TextEncoder, TextDecoder,
    performance, console, Blob: class {}, FileReader: class {}, Image: class {}, getComputedStyle: () => ({ getPropertyValue: () => '' }), innerWidth: 400, innerHeight: 800, devicePixelRatio: 1, screen: { width: 400, height: 800 },
    fetch: async () => { throw new Error('No network in tests: the page should use its fixture.'); },
  };
  window.window = window; window.self = window; window.globalThis = window;
  window.fwLabel = { views: (svg: string) => ({ el: new Element0('div'), set: noop, svg }) };
  const ctx = vm.createContext(window);
  const code = readFileSync(join(import.meta.dirname, '..', 'src', 'web', file), 'utf8');
  vm.runInContext(code, ctx, { filename: file });
  // Let the page's requests and timers settle.
  let last = '';
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 15));
    const now = allText(body);
    if (i > 4 && now === last) break;
    last = now;
  }
  return { root, body, document, text: () => allText(body), title: () => title };
}

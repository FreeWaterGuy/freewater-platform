import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Campaign, CompanyConfig } from '../../core/types';
import type { SqlClient } from '../../db/client';
import { newId } from '../../core/ids';
import type { Platform } from '../../platform';
import { linksOf } from '../artwork/links';
import { AdsError } from './service';
import { blocklist, type BlockKind } from './linkList';

export { blocklist, readBlocklist, type BlockKind } from './linkList';

/**
 * Link safety (docs/SWITCHES.md, "Link safety"; docs/THREAT-MODEL.md, "Link destinations"). The founder: every link an
 * ad leads to is approved before it goes live, "what if they changed it to porn or malware".
 *
 * Every link (a new ad's, a changed link, any URL an ad's code or scan page leads to) is checked automatically before a
 * person reviews it, and every live link again each day:
 *  1. On its face: https (an http link is checked as https), no user name or password in it, no IP address, no
 *     localhost or private-network name, no port but the usual one.
 *  2. Against the list (`link-blocklist.txt`, kept in the repo; plus the company's own `adRules.linkBlocked`): adult,
 *     malware and phishing domains, and link shorteners and QR redirect services that hide where people end up.
 *  3. Followed, from our server: every redirect (at most 5, each with a time limit), each hop's name looked up and
 *     refused if it points into a private network (so a link can't make our server fetch something inside one), and
 *     the request made to the address that was checked (never looked up again, so the answer can't change between).
 *     Each hop goes through 1 and 2 again.
 *  4. The last page: an error, a download instead of a page, or a title and labels that say "adult".
 *  5. Google Safe Browsing, when the host sets SAFE_BROWSING_API_KEY; without it the result says it wasn't asked.
 *
 * The answer: pass, flag (a person looks, with the reasons) or refuse (it can't be used: nothing is charged, nothing
 * goes live). A live link that turns bad on the daily re-check is put on hold: the ad's code opens a holding page
 * ("this link is being checked") until a person on the team clears it. Everything is recorded (`link_checks`).
 */

export const SWITCH = 'link_safety';
export type LinkVerdict = 'pass' | 'flag' | 'refuse';
export interface LinkReason {
  code: string;
  level: 'flag' | 'refuse';
  words: string;
  /** The address it was about (a redirect's, or the link's own). */
  url: string;
  /** On a live link: bad enough to put the ad's code on the holding page at once. */
  hold: boolean;
}
export interface LinkResult {
  url: string;
  /** Where it ended up after redirects (null when it wasn't followed). */
  final: string | null;
  hops: string[];
  verdict: LinkVerdict;
  reasons: LinkReason[];
  title: string | null;
  contentType: string | null;
  /** Whether it was followed and its page read ('offline': this server doesn't fetch pages; tests and laptops). */
  fetched: boolean | 'offline';
  /** 'stand_in': no SAFE_BROWSING_API_KEY, so the stand-in answered (it knows only Google's own test pages). */
  safeBrowsing: 'clear' | 'match' | 'stand_in' | 'not_configured' | 'unavailable' | 'not_checked';
}

export interface Fetched { status: number; headers: Record<string, string | string[] | undefined>; body: string }
/** Fetch one URL from the address already checked (never looked up again). */
export type Transport = (req: { url: URL; address: string; family: 4 | 6; timeoutMs: number; maxBytes: number }) => Promise<Fetched>;
export type Resolver = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;
export interface SafeBrowsing { readonly name: string; readonly standIn?: boolean; check(urls: string[]): Promise<{ url: string; threat: string }[]> }

export const MAX_HOPS = 5;
/** The most different links one check covers (an ad's links: its page, its versions, a static code). */
export const MAX_LINKS = 50;
const UA = 'FreeWater-LinkCheck/1.0 (+https://freewater.io/link-check)';

// ---------- the list (linkList.ts) ----------

export interface LinkRules { blocked: Map<string, BlockKind | 'company'>; allowed: Set<string> }
/** The repo's list, the company's own blocked domains, and the shorteners it allows (never an adult, malware or phishing domain). */
export function rulesFor(company: Pick<CompanyConfig, 'adRules'> | undefined): LinkRules {
  const blocked = new Map<string, BlockKind | 'company'>(blocklist());
  for (const d of company?.adRules?.linkBlocked ?? []) if (!blocked.has(d.toLowerCase())) blocked.set(d.toLowerCase(), 'company');
  return { blocked, allowed: new Set((company?.adRules?.linkAllowed ?? []).map((d) => d.toLowerCase())) };
}

// ---------- private networks ----------

const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['64:ff9b:1::', 48]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');
/** An IPv4 address carried inside an IPv6 one (mapped ::ffff:0:0/96, compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16), or null. */
function embeddedV4(ip: string): string | null {
  const parts = expand6(ip);
  if (!parts) return null;
  const v4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  if (parts.slice(0, 5).every((x) => x === 0) && (parts[5] === 0xffff || parts[5] === 0)) return v4(parts[6]!, parts[7]!);
  if (parts[0] === 0x64 && parts[1] === 0xff9b && parts.slice(2, 6).every((x) => x === 0)) return v4(parts[6]!, parts[7]!);
  if (parts[0] === 0x2002) return v4(parts[1]!, parts[2]!);
  return null;
}
function expand6(ip: string): number[] | null {
  const [head, tail] = ip.split('::');
  const read = (s: string | undefined) => (s ? s.split(':').flatMap((p) => (p.includes('.') ? (() => { const b = p.split('.').map(Number); return [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!]; })() : [parseInt(p, 16)])) : []);
  const h = read(head), t = tail === undefined ? [] : read(tail);
  if (tail === undefined && h.length !== 8) return null;
  const parts = [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  return parts.length === 8 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? parts : null;
}
/** Is this address inside a private, local or reserved network (any form of it)? */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return PRIVATE.check(ip, 'ipv4');
  if (v === 6) { if (PRIVATE.check(ip, 'ipv6')) return true; const e = embeddedV4(ip); return e ? PRIVATE.check(e, 'ipv4') : false; }
  return true; // not an address at all: never fetched
}

// ---------- 1 and 2: the link on its face ----------

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/i;

/** The domain on the list that covers this host (the host itself or one of its parents), with its kind. */
function listed(host: string, rules: LinkRules): { domain: string; kind: BlockKind | 'company' } | null {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    const kind = rules.blocked.get(d);
    if (kind && !(kind === 'shortener' && rules.allowed.has(d))) return { domain: d, kind };
  }
  return null;
}

const KIND_WORDS: Record<BlockKind | 'company', string> = {
  adult: 'is an adult site', malware: 'is known to spread harmful software', phishing: 'is known for stealing passwords or card numbers',
  shortener: 'is a link shortener: it hides where people end up, and where it leads can be changed after review. Use the real address',
  company: 'is on this company’s list of sites ads may not lead to',
};

/**
 * Checks a link can fail without fetching anything: refused (or, for an unusual port, flagged). `via` says it came from a
 * redirect. Returns the URL to fetch (http is checked as https on the first hop).
 */
export function faceCheck(raw: string, rules: LinkRules, via?: string): { url: URL | null; reasons: LinkReason[] } {
  const reasons: LinkReason[] = [];
  const say = (code: string, level: 'flag' | 'refuse', words: string, hold = level === 'refuse') => reasons.push({ code, level, words: via ? `${words} (it redirects to ${shorten(raw)})` : words, url: raw, hold });
  let url: URL;
  try { url = new URL(String(raw).trim()); } catch { say('bad_url', 'refuse', 'That isn’t a web address'); return { url: null, reasons }; }
  if (String(raw).length > 2000) say('too_long', 'refuse', 'That address is too long (2,000 characters at most)');
  if (url.protocol === 'http:' && !via) url = new URL(url.href.replace(/^http:/i, 'https:'));
  if (url.protocol !== 'https:' && !(via && url.protocol === 'http:')) say('not_https', 'refuse', 'A link must start with https:// (a web page)');
  if (via && url.protocol === 'http:') say('redirects_to_http', 'flag', 'It sends people on to a page without https, which anyone on the network can read or change', false);
  if (url.username || url.password) say('credentials', 'refuse', 'A link can’t carry a user name or password');
  // A trailing dot ("localhost.") names the same host: read without it.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIP(host)) say('ip_address', 'refuse', 'A link must use the site’s name, not a numeric address');
  else if (!host.includes('.') || LOCAL_NAMES.test(host)) say('private_host', 'refuse', 'That name only works inside a private network');
  if (url.port && url.port !== '443' && !(url.protocol === 'http:' && url.port === '80')) say('odd_port', 'flag', `It uses an unusual port (${url.port})`, false);
  const hit = isIP(host) ? null : listed(host, rules);
  if (hit) say(`listed_${hit.kind}`, 'refuse', `${hit.domain} ${KIND_WORDS[hit.kind]}`);
  return { url: reasons.some((r) => r.level === 'refuse') ? null : url, reasons };
}

// ---------- 4: the page ----------

const DOWNLOADS = /^(application\/(octet-stream|x-msdownload|x-msdos-program|x-msi|vnd\.microsoft\.portable-executable|vnd\.android\.package-archive|x-apple-diskimage|java-archive|x-java-archive|x-sh|x-executable|x-elf|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed))\b/i;
/** Words in a page's title or description that mark it as adult (whole words, so "Sussex" or "Middlesex" pass). */
export const ADULT_WORDS = /\b(porn\w*|xxx|nsfw|nudes?|naked|escorts?|hentai|milfs?|cam ?girls?|sex ?cams?|live ?sex|erotic\w*|adult (?:videos?|content|entertainment|dating|site))\b/i;
/** The self-label adult sites put in their pages (RTA), and the "adult" rating meta tag. */
const ADULT_LABEL = /RTA-5042-1996-1400-1577-RTA|<meta[^>]+name=["']?rating["']?[^>]+content=["']?(adult|mature|rta)/i;

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
export function pageFacts(body: string) {
  const title = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(body)?.[1];
  const desc = /<meta[^>]+name=["']?description["']?[^>]+content=["']([^"']{0,500})/i.exec(body)?.[1];
  const refresh = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\s*\d+\s*;\s*url\s*=\s*['"]?([^"'>\s]+)/i.exec(body)?.[1];
  return { title: title ? decode(title).slice(0, 200) : null, description: desc ? decode(desc) : null, refresh: refresh ? decode(refresh) : null, adultLabel: ADULT_LABEL.test(body) };
}
const header = (h: Fetched['headers'], k: string) => { const v = h[k] ?? h[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
const shorten = (u: string) => (u.length > 80 ? `${u.slice(0, 77)}…` : u);

// ---------- the checker ----------

export interface CheckerOptions {
  /** How names are looked up (the system's resolver in production; tests pass their own). */
  resolve: Resolver;
  /** How a page is fetched from a checked address. null: this server doesn't fetch (the offline stand-in). */
  transport: Transport | null;
  safeBrowsing: SafeBrowsing | null;
  timeoutMs?: number;
  maxBytes?: number;
}

export class LinkChecker {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  constructor(readonly opts: CheckerOptions) { this.timeoutMs = opts.timeoutMs ?? 4000; this.maxBytes = opts.maxBytes ?? 256 * 1024; }
  get offline() { return !this.opts.transport; }

  /** Check one link: on its face, against the lists, followed hop by hop, its last page, and Safe Browsing. */
  async check(raw: string, rules: LinkRules, opts: { follow?: boolean } = {}): Promise<LinkResult> {
    const face = faceCheck(raw, rules);
    const reasons = [...face.reasons];
    const out: LinkResult = { url: raw, final: null, hops: [], verdict: 'pass', reasons, title: null, contentType: null, fetched: false, safeBrowsing: 'not_checked' };
    if (!face.url) return finish(out);
    const transport = this.opts.transport;
    if (!transport || opts.follow === false) {
      out.fetched = transport ? false : 'offline';
      return finish(await this.safeBrowse(out, [face.url.href]));
    }
    let url: URL = face.url;
    const seen = [url.href];
    for (let hop = 0; ; hop++) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addrs: { address: string; family: 4 | 6 }[] = [];
      try { addrs = await withTimeout(this.opts.resolve(host), this.timeoutMs); } catch { /* no answer: said below */ }
      if (!addrs.length) { reasons.push({ code: 'no_such_site', level: 'flag', words: `${host} doesn’t exist or didn’t answer`, url: url.href, hold: false }); break; }
      const bad = addrs.find((a) => isPrivateAddress(a.address));
      if (bad) { reasons.push({ code: 'private_network', level: 'refuse', words: hop ? `It redirects into a private network (${host})` : `${host} points into a private network`, url: url.href, hold: true }); break; }
      let got: Fetched;
      try { got = await transport({ url, address: addrs[0]!.address, family: addrs[0]!.family, timeoutMs: this.timeoutMs, maxBytes: this.maxBytes }); } catch (e) {
        reasons.push({ code: 'unreachable', level: 'flag', words: `The page didn’t load (${String((e as Error)?.message ?? e).slice(0, 80)})`, url: url.href, hold: false }); break;
      }
      out.fetched = true;
      const type = String(header(got.headers, 'content-type') ?? '').toLowerCase();
      const facts = /html/.test(type) ? pageFacts(got.body) : null;
      const location = got.status >= 300 && got.status < 400 ? header(got.headers, 'location') : facts?.refresh ?? undefined;
      if (location) {
        if (hop + 1 >= MAX_HOPS) { reasons.push({ code: 'too_many_redirects', level: 'flag', words: `It redirects more than ${MAX_HOPS} times`, url: url.href, hold: false }); break; }
        let next: string;
        try { next = new URL(location, url).href; } catch { reasons.push({ code: 'bad_redirect', level: 'flag', words: 'It redirects to an address that isn’t valid', url: url.href, hold: false }); break; }
        if (seen.includes(next)) { reasons.push({ code: 'redirect_loop', level: 'flag', words: 'It redirects in a loop', url: next, hold: false }); break; }
        seen.push(next);
        out.hops.push(next);
        const f = faceCheck(next, rules, url.href);
        reasons.push(...f.reasons);
        if (!f.url) break;
        url = f.url;
        continue;
      }
      out.final = url.href;
      out.contentType = type.split(';')[0] || null;
      if (got.status >= 400) reasons.push({ code: 'page_error', level: 'flag', words: `The page answers with an error (${got.status})`, url: url.href, hold: false });
      const disposition = String(header(got.headers, 'content-disposition') ?? '');
      if (DOWNLOADS.test(type) || /^\s*attachment/i.test(disposition)) reasons.push({ code: 'download', level: 'refuse', words: 'It downloads a file instead of opening a page', url: url.href, hold: true });
      if (facts) {
        out.title = facts.title;
        if (facts.adultLabel) reasons.push({ code: 'adult_label', level: 'refuse', words: 'The page labels itself as adult content', url: url.href, hold: true });
        else if (ADULT_WORDS.test(`${facts.title ?? ''} ${facts.description ?? ''}`)) reasons.push({ code: 'adult_words', level: 'flag', words: `The page’s title or description reads as adult (“${shorten(facts.title ?? facts.description ?? '')}”)`, url: url.href, hold: true });
      }
      break;
    }
    return finish(await this.safeBrowse(out, seen));
  }

  private async safeBrowse(out: LinkResult, urls: string[]): Promise<LinkResult> {
    const sb = this.opts.safeBrowsing;
    if (!sb) { out.safeBrowsing = 'not_configured'; return out; }
    try {
      const hits = await withTimeout(sb.check([...new Set(urls)].slice(0, 20)), this.timeoutMs + 1000);
      out.safeBrowsing = hits.length ? 'match' : sb.standIn ? 'stand_in' : 'clear';
      for (const h of hits.slice(0, 3)) out.reasons.push({ code: 'safe_browsing', level: 'refuse', words: `${sb.name} lists it as unsafe (${String(h.threat).toLowerCase().replace(/_/g, ' ')})`, url: h.url ?? out.url, hold: true });
    } catch { out.safeBrowsing = 'unavailable'; }
    return out;
  }
}

function finish(r: LinkResult): LinkResult {
  r.verdict = r.reasons.some((x) => x.level === 'refuse') ? 'refuse' : r.reasons.length ? 'flag' : 'pass';
  return r;
}
const withTimeout = <T>(p: Promise<T>, ms: number) => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timed out')), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// ---------- the real network (production) ----------

/** The system's resolver: every address a name has. */
export const systemResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/**
 * Fetch from the address that was checked: the name is never looked up again (a second answer could point inside the
 * network), certificates are checked as usual for the name, no cookies, at most `maxBytes` read, one time limit.
 */
export const netTransport: Transport = ({ url, address, family, timeoutMs, maxBytes }) => new Promise<Fetched>((resolve, reject) => {
  const mod = url.protocol === 'https:' ? https : http;
  const pinned = (_host: string, o: any, cb: any) => (o?.all ? cb(null, [{ address, family }]) : cb(null, address, family));
  const req = mod.request(url, { method: 'GET', agent: false, lookup: pinned as any, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.5', 'accept-encoding': 'identity' } });
  const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
  req.on('error', (e) => { clearTimeout(timer); reject(e); });
  req.on('response', (res) => {
    const chunks: Buffer[] = [];
    let n = 0, done = false;
    const end = () => { if (done) return; done = true; clearTimeout(timer); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); };
    res.on('data', (c: Buffer) => { if (n < maxBytes) chunks.push(c.subarray(0, maxBytes - n)); n += c.length; if (n >= maxBytes) { end(); res.destroy(); } });
    res.on('end', end);
    res.on('error', (e) => { if (!done) { clearTimeout(timer); reject(e); } });
  });
  req.end();
});

/** Google Safe Browsing (v4 Lookup API), with the host's key. Note its terms: the Lookup API is for non-commercial use; Web Risk is Google's commercial one (COMPLIANCE L-39). */
export function googleSafeBrowsing(apiKey: string, fetchImpl: typeof fetch = fetch): SafeBrowsing {
  return {
    name: 'Google Safe Browsing',
    async check(urls) {
      const r = await fetchImpl(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ client: { clientId: 'freewater', clientVersion: '1.0' }, threatInfo: { threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'], platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: urls.map((url) => ({ url })) } }),
      });
      if (!r.ok) throw new Error(`Safe Browsing answered ${r.status}`);
      const j: any = await r.json();
      return (Array.isArray(j?.matches) ? j.matches : []).map((m: any) => ({ url: String(m?.threat?.url ?? ''), threat: String(m?.threatType ?? 'unsafe') }));
    },
  };
}

/**
 * Without SAFE_BROWSING_API_KEY: a stand-in that asks no one. It knows only Google's own published test pages (so the
 * whole path can be tried), says it's a stand-in in every result, and lets the list and the page check do the rest.
 */
export const standInSafeBrowsing: SafeBrowsing = {
  name: 'Safe Browsing stand-in (no key set)', standIn: true,
  async check(urls) {
    const TEST: Record<string, string> = { 'malware.html': 'MALWARE', 'phishing.html': 'SOCIAL_ENGINEERING', 'unwanted.html': 'UNWANTED_SOFTWARE', 'harmful.html': 'POTENTIALLY_HARMFUL_APPLICATION' };
    return urls.flatMap((u) => { try { const x = new URL(u); const t = x.hostname === 'testsafebrowsing.appspot.com' ? TEST[x.pathname.split('/').pop() ?? ''] : undefined; return t ? [{ url: u, threat: t }] : []; } catch { return []; } });
  },
};

/** The checker for this server: the real network in production (and wherever the host asks), else the offline stand-in. */
export function checkerFromEnv(env: NodeJS.ProcessEnv = process.env, o: { network?: boolean } = {}): LinkChecker {
  const network = o.network ?? (env.NODE_ENV === 'production' || env.FW_LINK_CHECK === 'network');
  return new LinkChecker({ resolve: systemResolver, transport: network ? netTransport : null, safeBrowsing: env.SAFE_BROWSING_API_KEY ? googleSafeBrowsing(env.SAFE_BROWSING_API_KEY) : standInSafeBrowsing });
}

// ---------- the service: checks recorded, refusals, the daily re-check and holds ----------

export interface Checked { verdict: LinkVerdict; results: LinkResult[] }
export type Purpose = 'draft' | 'submit' | 'change' | 'campaign' | 'recheck' | 'release';

/** Every reason in plain words, one line. */
export const reasonWords = (rs: LinkResult[], level?: 'flag' | 'refuse') => [...new Set(rs.flatMap((r) => r.reasons.filter((x) => !level || x.level === level).map((x) => `${shorten(r.url)}: ${x.words}.`)))].join(' ');

export class LinkSafetyService {
  alert: (key: string, title: string, detail: string) => void = () => {};

  constructor(private db: SqlClient, private platform: Platform, private on: (companyId: string, id: string) => boolean, public checker: LinkChecker) {}

  private now() { return this.platform.bus.now().toISOString(); }
  enabled(companyId: string) { return this.on(companyId, SWITCH); }

  /**
   * Check links for a company and record each result. With "Link safety" off (an owner's choice, with a reason), only
   * the face checks run (https, no password, no private address): the list, redirects and the page aren't checked.
   */
  async check(companyId: string, urls: string[], ctx: { purpose: Purpose; campaignId?: string | null; advertiserId?: string | null }): Promise<Checked> {
    const all = [...new Set(urls.map((u) => String(u ?? '').trim()).filter(Boolean))];
    // More than this is never checked in part: the links past it would go unchecked, so the whole lot is refused.
    if (all.length > MAX_LINKS) throw new AdsError(422, 'too_many_links', `An ad can lead to at most ${MAX_LINKS} different links; this one has ${all.length}. Nothing was charged or changed.`);
    const list = all;
    if (!list.length) return { verdict: 'pass', results: [] };
    const on = this.enabled(companyId);
    const rules = on ? rulesFor(this.platform.companies.get(companyId)) : { blocked: new Map(), allowed: new Set<string>() };
    const results: LinkResult[] = [];
    for (let i = 0; i < list.length; i += 8) results.push(...await Promise.all(list.slice(i, i + 8).map((u) => this.checker.check(u, rules, { follow: on }))));
    const at = this.now();
    for (const r of results) {
      await this.db.query(`insert into link_checks (id, company_id, campaign_id, advertiser_id, purpose, url, final_url, hops, verdict, reasons, title, content_type, fetched, safe_browsing, switch_on, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [newId('lnk'), companyId, ctx.campaignId ?? null, ctx.advertiserId ?? null, ctx.purpose, r.url.slice(0, 2000), r.final?.slice(0, 2000) ?? null, JSON.stringify(r.hops), r.verdict, JSON.stringify(r.reasons), r.title, r.contentType, String(r.fetched), r.safeBrowsing, on, at]);
    }
    return { verdict: results.some((r) => r.verdict === 'refuse') ? 'refuse' : results.some((r) => r.verdict === 'flag') ? 'flag' : 'pass', results };
  }

  /** Check, and refuse (422, nothing charged, nothing saved) when any link can't be used. Returns what a person should look at. */
  async screen(companyId: string, urls: string[], ctx: { purpose: Purpose; campaignId?: string | null; advertiserId?: string | null }): Promise<Checked> {
    const out = await this.check(companyId, urls, ctx);
    if (out.verdict === 'refuse') throw new AdsError(422, 'link_unsafe', `That link can’t be used: ${reasonWords(out.results, 'refuse')} Nothing was charged or changed.`);
    return out;
  }

  /**
   * Any other way an ad's links change (P3: the campaign's own routes, `POST /v1/campaigns`, `PATCH …/:id`, `PATCH
   * …/:id/codes`): the links that are new are checked before anything changes (an unsafe one refused, 422), and the
   * reasons a person should see come back as flag lines for the review.
   */
  async screenChange(c: { companyId: string; id: string; advertiserId: string }, before: { url: string }[] | null, after: { url: string }[]): Promise<string[]> {
    const had = new Set((before ?? []).map((l) => l.url));
    const fresh = after.map((l) => l.url).filter((u) => !had.has(u));
    if (!fresh.length) return [];
    return this.flagLines(await this.screen(c.companyId, fresh, { purpose: 'campaign', campaignId: c.id, advertiserId: c.advertiserId }));
  }

  /** The reasons a person reviewing should see, as flag lines (null when every link passed). */
  flagLines(c: Checked): string[] {
    return c.verdict === 'flag' ? [`Link safety check: ${reasonWords(c.results, 'flag')} A person decides whether it may run.`] : [];
  }

  /** Live ads: approved, not stopped, not on hold. */
  private live(companyId: string) {
    return [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && !c.isHouse && !c.filler && c.review?.status === 'approved' && !c.prepaid?.stoppedAt && !c.linkHold);
  }

  /**
   * The daily re-check of every live ad's links. A link that turned bad (now refused, or now reading as adult) puts the
   * ad's code on the holding page at once and alerts the team; one that only needs a look (it stopped loading) alerts.
   */
  async recheck(companyId: string) {
    if (!this.enabled(companyId)) return { checked: 0, held: [] as string[], needsALook: [] as string[] };
    const held: string[] = [], look: string[] = [];
    let checked = 0;
    for (const c of this.live(companyId)) {
      const urls = linksOf(c).map((l) => l.url);
      if (!urls.length) continue;
      const out = await this.check(companyId, urls, { purpose: 'recheck', campaignId: c.id, advertiserId: c.advertiserId });
      checked += out.results.length;
      const bad = out.results.flatMap((r) => r.reasons.filter((x) => x.hold).map((x) => ({ url: r.url, words: x.words })));
      if (bad.length) { await this.hold(c, bad); held.push(c.id); }
      else if (out.verdict === 'flag') { look.push(c.id); this.alert(`link-look:${c.id}`, `A live ad’s link needs a look: ${c.advertiserName}`, reasonWords(out.results, 'flag')); }
    }
    return { checked, held, needsALook: look };
  }

  /** Put an ad's code on the holding page: kept, recorded, the team alerted. Printing goes on (each code opens the holding page). */
  async hold(c: Campaign, bad: { url: string; words: string }[]) {
    if (c.linkHold) return c.linkHold;
    const at = this.now(), id = newId('lhd');
    const why = [...new Set(bad.map((b) => `${shorten(b.url)}: ${b.words}`))].join(' · ').slice(0, 1000);
    await this.db.query(`insert into link_holds (id, company_id, campaign_id, advertiser_id, urls, reasons, held_at) values ($1,$2,$3,$4,$5,$6,$7)`, [id, c.companyId, c.id, c.advertiserId, JSON.stringify([...new Set(bad.map((b) => b.url))]), why, at]);
    c.linkHold = { id, at, reasons: why };
    this.platform.persist.campaign(c);
    this.alert(`link-hold:${c.id}`, `A live ad’s link turned bad: ${c.advertiserName}’s code now opens the holding page`, `${why} A person on the team checks it and clears it (Ops → Ad review → Links on hold) once it’s safe, or the advertiser changes the link.`);
    return c.linkHold;
  }

  /** Links on hold, for the team. */
  async holds(companyId: string) {
    return (await this.db.query<any>(`select id, campaign_id, advertiser_id, urls, reasons, held_at, released_at, released_by, release_reason from link_holds where company_id = $1 order by held_at desc limit 100`, [companyId])).rows.map((r) => ({
      id: r.id as string, campaignId: r.campaign_id as string, advertiser: this.platform.campaigns.get(r.campaign_id)?.advertiserName ?? null, urls: typeof r.urls === 'string' ? JSON.parse(r.urls) : r.urls, reasons: r.reasons as string,
      heldAt: new Date(r.held_at).toISOString(), released: r.released_at ? { at: new Date(r.released_at).toISOString(), by: r.released_by as string, reason: r.release_reason as string } : null,
    }));
  }

  /**
   * A person on the team clears a hold, with a reason, once the links are checked again and nothing is refused or
   * reads as adult. Never a key (the route asks for a person).
   */
  async release(companyId: string, campaignId: string, who: { userId: string; name: string }, reason: string) {
    const c = this.platform.campaigns.get(campaignId);
    if (!c || c.companyId !== companyId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    if (!c.linkHold) throw new AdsError(409, 'not_held', 'This ad’s links aren’t on hold.');
    const why = String(reason ?? '').trim();
    if (why.length < 10) throw new AdsError(422, 'reason_required', 'Say what you checked, for the record (at least 10 characters).');
    const out = await this.check(companyId, linksOf(c).map((l) => l.url), { purpose: 'release', campaignId: c.id, advertiserId: c.advertiserId });
    const still = out.results.flatMap((r) => r.reasons.filter((x) => x.hold));
    if (still.length) throw new AdsError(409, 'still_unsafe', `Still not safe: ${reasonWords(out.results)} The advertiser can change the link (Change a link), which a person reviews.`);
    const r = (await this.db.query<any>(`update link_holds set released_at = $3, released_by = $4, release_reason = $5 where id = $1 and company_id = $2 and released_at is null returning id`, [c.linkHold.id, companyId, this.now(), `user:${who.userId}`, why.slice(0, 500)])).rows[0];
    if (!r) throw new AdsError(409, 'not_held', 'Someone already cleared this hold.');
    delete c.linkHold;
    this.platform.persist.campaign(c);
    return { campaignId: c.id, released: true };
  }

  /** A hold ends when a reviewed link change replaces the held links (the new links passed their own check and a person). */
  async endHoldByChange(c: Campaign, by: string) {
    if (!c.linkHold) return;
    await this.db.query(`update link_holds set released_at = $3, released_by = $4, release_reason = $5 where id = $1 and company_id = $2 and released_at is null`, [c.linkHold.id, c.companyId, this.now(), by, 'The advertiser changed the link; the new link was checked and approved.']);
    delete c.linkHold;
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The books the agents work from: Abundance Engineering (the frameworks, in depth) and How to Make a Free Product
 * Company (the business models). Kept as markdown in /books, split into passages (a paragraph each) with stable ids
 * like AE.11.2.3 (book, chapter, section, paragraph), searchable, and cited by id in what an agent proposes.
 *
 * The books explain the reasoning; the charter says when to use it; the code enforces what must never vary. And one
 * rule above all: every number in a book is an example that shows an idea, never a fact about FreeWater.
 */
export interface BookInfo { id: string; file: string; title: string; author: string; edition: string; date: string; authorityOn: string[]; current: boolean }
export interface Passage {
  id: string;
  book: string;
  part?: string;
  chapter: string;
  chapterNo: number | null;
  section?: string;
  text: string;
  /** The passage has figures in it: they're examples, never facts about FreeWater. */
  hasNumbers: boolean;
}
export interface Hit { passage: Passage; score: number }

const STOP = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it its just more most no not of on once one only or other our out over so such than that the their them then there these they this those through to too up us very was we were what when where which while who why will with would you your yours it\'s isn\'t doesn\'t don\'t'.split(' '));
const stem = (w: string) => w.replace(/(?:'s|’s)$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, (m, _x, i, s: string) => (s.length - m.length >= 3 ? '' : m));
export const tokens = (s: string) => s.toLowerCase().replace(/[’']/g, "'").split(/[^a-z0-9']+/).filter((w) => w && !STOP.has(w)).map(stem).filter((w) => w.length > 1);
const NUMBER = /(\$\s?\d|\d+\s?(%|percent|cents?|¢|dollars?|million|billion|trillion|years?|gigawatts?|GW|MW|kWh|bottles?|units?))|\b\d{2,}[,.]?\d*\b/i;

export class BookLibrary {
  readonly info: { about: string; rules: string[]; books: BookInfo[] };
  readonly passages: Passage[] = [];
  private byId = new Map<string, Passage>();
  // Search index (BM25 over passages, with chapter and section titles counted in).
  private df = new Map<string, number>();
  private docs: { tf: Map<string, number>; len: number }[] = [];
  private avgLen = 1;

  constructor(dir = defaultDir()) {
    this.info = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    for (const b of this.info.books) this.load(b, readFileSync(join(dir, b.file), 'utf8'));
    for (const p of this.passages) {
      const tf = new Map<string, number>();
      const words = [...tokens(p.text), ...tokens(`${p.chapter} ${p.section ?? ''}`).flatMap((w) => [w, w])];
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      this.docs.push({ tf, len: words.length });
    }
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  private load(book: BookInfo, md: string) {
    let part: string | undefined, chapter = 'Front matter', chapterNo: number | null = null, section: string | undefined;
    let chapterKey = 'front', sectionNo = 0, paraNo = 0, unnumbered = 0;
    const add = (text: string) => {
      const t = text.trim();
      if (t.length < 40 || /^[*_#\s-]+$/.test(t)) return;
      paraNo++;
      const p: Passage = { id: `${book.id}.${chapterKey}.${sectionNo}.${paraNo}`, book: book.id, part, chapter, chapterNo, section, text: t, hasNumbers: NUMBER.test(t) };
      this.passages.push(p);
      this.byId.set(p.id, p);
    };
    let para: string[] = [];
    const flush = () => { if (para.length) add(para.join(' ')); para = []; };
    for (const raw of md.split('\n')) {
      const line = raw.trimEnd();
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        const level = h[1]!.length, title = h[2]!.replace(/[*_]/g, '').trim();
        const cm = /^Chapter (\d+)\s*:\s*(.*)$/i.exec(title);
        if (level === 1 && /^Part \d/i.test(title)) { part = title; continue; }
        if (level === 1) continue; // the book's own title
        if (level === 2) {
          chapter = cm ? `Chapter ${cm[1]}: ${cm[2]}` : title;
          chapterNo = cm ? Number(cm[1]) : null;
          const sm = /^Slide (\d+)\s*:/i.exec(title);
          chapterKey = cm ? String(cm[1]) : sm ? `s${sm[1]}` : `x${++unnumbered}`;
          section = undefined; sectionNo = 0; paraNo = 0;
          continue;
        }
        section = title; sectionNo++; paraNo = 0;
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      para.push(line.trim());
    }
    flush();
  }

  book(id: string) { return this.info.books.find((b) => b.id === id); }
  passage(id: string) { return this.byId.get(id); }

  /** The best passages for a question. `book` limits it to one book. */
  search(query: string, opts: { book?: string; k?: number } = {}): Hit[] {
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const N = this.docs.length, k1 = 1.4, b = 0.75;
    const out: Hit[] = [];
    for (let i = 0; i < N; i++) {
      const p = this.passages[i]!;
      if (opts.book && p.book !== opts.book) continue;
      const d = this.docs[i]!;
      let score = 0;
      for (const w of q) {
        const f = d.tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(w) ?? 0) + 0.5) / ((this.df.get(w) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      if (score > 0) out.push({ passage: p, score: Math.round(score * 100) / 100 });
    }
    return out.sort((x, y) => y.score - x.score).slice(0, opts.k ?? 8);
  }

  /** Every passage of a chapter (or one section of it). */
  chapter(book: string, chapterNo: number, section?: string) {
    return this.passages.filter((p) => p.book === book && p.chapterNo === chapterNo && (!section || p.section === section));
  }

  /** Where a passage sits, in words: "Abundance Engineering, Chapter 11: Consecutive Delivery › The Route as the Asset". */
  where(p: Passage) { return `${this.book(p.book)?.title ?? p.book}, ${p.chapter}${p.section ? ` › ${p.section}` : ''}`; }

  /** Check citations: every id must be a real passage. Returns the unknown ones. */
  unknown(ids: string[]) { return ids.filter((id) => !this.byId.has(id)); }

  /**
   * The reading an agent gets before it decides: the rules, then the best passages for its question, each with its
   * id so it can cite them. Book numbers are flagged as examples, every time.
   */
  context(query: string, opts: { k?: number; maxChars?: number } = {}) {
    const hits = this.search(query, { k: opts.k ?? 6 });
    const max = opts.maxChars ?? 6000;
    const parts = [
      'From the books (cite by id; the ideas guide you, but every number in them is an example, never a fact about FreeWater: use numbers from the platform\'s own books or real quotes):',
    ];
    let used = parts[0]!.length;
    for (const h of hits) {
      const t = `[${h.passage.id}] (${this.where(h.passage)})${h.passage.hasNumbers ? ' [numbers here are examples]' : ''}: ${h.passage.text}`;
      if (used + t.length > max) break;
      parts.push(t); used += t.length;
    }
    return { text: parts.join('\n\n'), ids: hits.map((h) => h.passage.id) };
  }
}

function defaultDir() {
  // src/modules/knowledge → the repository's /books (also where the image keeps them).
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, '..', '..', '..', 'books'), join(process.cwd(), 'books')]) if (existsSync(join(d, 'index.json'))) return d;
  throw new Error('The books folder (books/index.json) is missing.');
}

let shared: BookLibrary | null = null;
/** The library, read once. */
export function books() { return (shared ??= new BookLibrary()); }

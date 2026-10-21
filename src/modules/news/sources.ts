/**
 * The outlets people can pick as their favourite news sources, unless a company sets its own (`news.sources`). This is
 * a SAMPLE list: which outlets to offer is the founder's choice. Picking one only chooses the style our story is
 * written in (FreeWater News, in our own words, from several outlets); it never brings that outlet's name or look onto
 * our page, and we never guess anyone's choice from what they do.
 */
export interface NewsSource { id: string; name: string; url: string }

export const sampleNewsSources: NewsSource[] = [
  { id: 'ap', name: 'AP News', url: 'https://apnews.com' },
  { id: 'reuters', name: 'Reuters', url: 'https://www.reuters.com' },
  { id: 'npr', name: 'NPR', url: 'https://www.npr.org' },
  { id: 'bbc', name: 'BBC News', url: 'https://www.bbc.com/news' },
  { id: 'wsj', name: 'The Wall Street Journal', url: 'https://www.wsj.com' },
  { id: 'nyt', name: 'The New York Times', url: 'https://www.nytimes.com' },
  { id: 'fox', name: 'Fox News', url: 'https://www.foxnews.com' },
  { id: 'cnn', name: 'CNN', url: 'https://www.cnn.com' },
  { id: 'texas-tribune', name: 'The Texas Tribune', url: 'https://www.texastribune.org' },
  { id: 'kut', name: 'KUT News', url: 'https://www.kut.org' },
];

const ID = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** A company's own list: 2 to 30 outlets, each with a short id, a name and an https address. */
export function checkNewsSettings(n: unknown): string | null {
  if (n === undefined) return null;
  const s = n as { on?: unknown; sources?: unknown };
  if (!s || typeof s !== 'object' || typeof s.on !== 'boolean') return 'News is on or off (news.on true or false).';
  if (s.sources === undefined) return null;
  if (!Array.isArray(s.sources) || s.sources.length < 2 || s.sources.length > 30) return 'News sources are a list of 2 to 30 outlets.';
  const ids = new Set<string>();
  for (const x of s.sources as any[]) {
    if (!x || typeof x !== 'object' || !ID.test(x.id ?? '') || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 60 || typeof x.url !== 'string' || !/^https:\/\/[^\s"'<>]{3,200}$/.test(x.url)) return 'Each news source has a short id (like ap), a name and an https address.';
    if (ids.has(x.id)) return `The news source id ${x.id} is used twice.`;
    ids.add(x.id);
  }
  return null;
}

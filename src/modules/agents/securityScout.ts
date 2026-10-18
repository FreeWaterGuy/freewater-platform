import type { CompanyConfig } from '../../core/types';
import type { Idea } from './scouts';

// The security agent's look at the platform. It never sits in the path of a request: it reads the security log and
// the company's keys, team and connections once an hour, in the background, and proposes what would make things
// safer. People decide; anything that can't be undone (revoking a key) always waits for a person.

export interface SecurityFacts {
  events: { kind: string; ipTag?: string | null; actor?: string | null; at: string }[]; // the last 7 days
  keys: { id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt?: string | null; advertiserId?: string | null; locationId?: string | null }[];
  webhooks: { id: string; url: string; status: string }[];
  owners: number; // people with the owner role
  now: Date;
}

const DAY = 86_400_000;

export function securityScan(c: CompanyConfig, f: SecurityFacts, open: Set<string>): Idea[] {
  const ideas: Idea[] = [];
  const add = (i: Omit<Idea, 'agentId'>) => { if (!i.change || !open.has(i.change.path)) ideas.push({ agentId: 'security', ...i }); };
  const count = (k: string) => f.events.filter((e) => e.kind === k).length;

  // Keys nobody has used in 90 days are doors left open.
  for (const k of f.keys) {
    const last = new Date(k.lastUsedAt ?? k.createdAt).getTime();
    const days = Math.floor((f.now.getTime() - last) / DAY);
    if (days >= 90) add({ kind: 'security', title: `Turn off the key “${k.name}” (unused for ${days} days)`, detail: `It ${k.lastUsedAt ? `was last used ${days} days ago` : `was made ${days} days ago and never used`}. A key nobody uses can only be used by someone who shouldn’t have it. Turning it off can’t be undone; make a new one if it’s needed again.`, change: { path: `security:revoke-key:${k.id}`, value: null }, expected: 'One fewer way in.' });
  }
  // Wide keys: a key that can do everything is worth more to a thief than one that does one job.
  const wide = f.keys.filter((k) => k.scopes.includes('admin') && !k.advertiserId && !k.locationId);
  if (wide.length > 3) add({ kind: 'note', title: `${wide.length} keys can do everything`, detail: `Keys with full (admin) access: ${wide.map((k) => `“${k.name}”`).join(', ')}. Give each system a key with only the access it needs, and turn the wide ones off.` });
  // Sign-in and key guessing.
  const failed = count('sign_in_failed'), blocked = count('blocked_bad_keys'), limited = count('rate_limited');
  const tags = new Map<string, number>();
  for (const e of f.events) if (e.ipTag && ['sign_in_failed', 'blocked_bad_keys', 'rate_limited'].includes(e.kind)) tags.set(e.ipTag, (tags.get(e.ipTag) ?? 0) + 1);
  const loud = [...tags.entries()].filter(([, n]) => n >= 10).sort((a, b) => b[1] - a[1]);
  if (blocked || loud.length) add({ kind: 'note', title: `Someone has been trying keys or sign-in codes (${blocked} blocks this week)`, detail: `${failed} failed sign-ins, ${blocked} addresses blocked for wrong keys and ${limited} rate limits in the last 7 days${loud.length ? `; ${loud.length} address${loud.length === 1 ? '' : 'es'} did most of it` : ''}. The limits held. If it continues, put the API behind a firewall rule for those networks, or add a second sign-in step for owners.` });
  else if (failed >= 20) add({ kind: 'note', title: `${failed} failed sign-ins this week`, detail: 'More than usual. Check with the team whether these were them (a mistyped email), and watch for a pattern.' });
  // Connections out: webhooks should be encrypted.
  for (const w of f.webhooks) if (w.status === 'active' && w.url.startsWith('http://')) add({ kind: 'note', title: 'A webhook sends to an unencrypted address', detail: `${w.url} uses http, not https: what it receives can be read on the way. Change it to https.` });
  // Owners: one is a single point of failure, many is a wide door.
  if (f.owners > 4) add({ kind: 'note', title: `${f.owners} people are owners`, detail: 'Owners can do everything. Give people the narrowest role that fits (operations, finance, reviewer) and keep owners to a few.' });
  if (f.owners === 1) add({ kind: 'note', title: 'Only one owner', detail: 'If that one account is lost, nobody can manage the company. Add a second owner you trust.' });
  void c;
  return ideas;
}

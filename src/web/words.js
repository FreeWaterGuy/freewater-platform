// Plain words for the codes the server speaks, in one place for the ops, console and driver screens: statuses, a
// driver's skip reasons, security log events and their details, who did something (a name, never "user:usr_…"), and
// dates and times in the company's time zone. A code with no entry here is still turned into words ("box_printed" →
// "Box printed"), so a new code never reaches a screen raw; test/plain-words.test.ts checks the lists are complete.
(() => {
  'use strict';

  /** Statuses of packs, runs, stops, houses, subscriptions, chain actions and machine commands. */
  const STATUS = {
    // a pack (a box of bottles)
    composed: 'Being printed', box_printed: 'Printed, waiting for its check', mismatch: 'Packing line found it wrong', verified: 'Checked',
    sealed: 'Sealed', loaded: 'On the van', delivered: 'Delivered', returned: 'Came back',
    // a run and its stops
    printing: 'Printing', packing: 'Packing check', ready: 'Ready to load', out: 'Out on the road', done: 'Done', planned: 'Planned', not_delivered: 'Not delivered',
    // a house in a delivery area
    active: 'Gets packs', opted_out: 'Stopped in the app', skip_pending: 'Driver skip: review', skipped: 'Skipped', merged: 'Merged with another',
    // a subscription
    paused: 'Paused', cancelled: 'Cancelled',
    // an action that needs several people
    proposed: 'Waiting for approvals', approved: 'Approved, waiting', signing: 'Waiting to be signed', expired: 'Expired', failed: 'Failed', noted: 'Noted',
    // a machine command
    pending: 'Waiting', sent: 'Waiting',
  };

  /** Why a driver passed a house by (src/modules/delivery/houses.ts SKIP_LABELS). */
  const SKIP = { locked_gate: 'Locked gate', dangerous_animal: 'Dangerous animal', unsafe: 'Not safe', no_safe_place: 'No safe place to leave it', not_a_home: 'Not a home' };

  /** The security log's events (src/api/server.ts and src/api/security.ts). */
  const EVENTS = {
    signed_in: 'Signed in', sign_in_failed: 'Failed sign-in', second_step_on: 'Second sign-in step turned on', second_step_off: 'Second sign-in step turned off',
    second_step_failed: 'Wrong second-step code', recovery_code_used: 'Signed in with a recovery code', key_created: 'Key made', key_revoked: 'Key turned off',
    team_member_added: 'Team member added', team_member_removed: 'Team member removed', settings_saved: 'Settings saved', settings_restored: 'Old settings put back',
    autonomy_changed: 'Self-running level changed', licensee_created: 'Licensee set up', batch_voided: 'Batch voided', webhook_created: 'Webhook added',
    pack_checked_by_hand: 'Box checked by hand', rate_limited: 'Too many requests (slowed down)', blocked_bad_keys: 'Blocked for wrong keys',
    upload_capped: 'Upload refused (too big)', print_rate_capped: 'Machine printing too fast (held)',
  };

  /** The names of details on a security event, and of what's in them. */
  const DETAIL_KEYS = { role: 'Role', approvesFrom: 'Approves from', secondStep: 'With', reason: 'Why', limit: 'Limit', url: 'Page', name: 'Name', scopes: 'Can use', email: 'Email', id: 'Which', userId: 'Person', version: 'Version', locationId: 'Machine', stop: 'Stop', level: 'Level' };
  const ROLES = { owner: 'Owner', ops: 'Ops', driver: 'Driver', finance: 'Finance', reviewer: 'Reviewer', consumer: 'Customer' };

  /** Any code in words: "box_printed" → "Box printed". */
  const humanize = (code) => {
    const s = String(code ?? '').replace(/[_-]+/g, ' ').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : '';
  };
  const status = (code) => (code == null || code === '' ? '' : STATUS[code] ?? humanize(code));
  /** "locked_gate: the gate was chained" → "Locked gate: the gate was chained". */
  const skipReason = (text) => {
    if (!text) return '';
    const t = String(text), at = t.indexOf(':');
    const code = at < 0 ? t : t.slice(0, at), note = at < 0 ? '' : t.slice(at + 1).trim();
    if (!Object.prototype.hasOwnProperty.call(SKIP, code)) return t;
    return note ? `${SKIP[code]}: ${note}` : SKIP[code];
  };
  const event = (kind) => EVENTS[kind] ?? humanize(kind);
  const role = (r) => ROLES[r] ?? humanize(r);

  /** The company's time zone, set by each screen once it knows it (unset: the browser's own). */
  let zone;
  const setZone = (tz) => { zone = tz || undefined; };
  const fmt = (iso, opts) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleString('en-US', { ...opts, ...(zone ? { timeZone: zone } : {}) }); } catch { return d.toLocaleString('en-US', opts); }
  };
  /** "Nov 10, 7:42 PM", in the company's time zone. */
  const when = (iso) => fmt(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || '—';
  /** "7:42 PM", in the company's time zone. */
  const time = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' }) || '—';
  /** A calendar day ("2026-11-10") as "Tue, Nov 10": a day, so no time zone moves it. */
  const day = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''));
    if (!m) return ymd ? String(ymd) : '—';
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  /** "route-3" → "Route 3". */
  const route = (id) => String(id ?? '').replace(/^route-/, 'Route ');

  /**
   * Who did something, as a name. `names` maps a person's id to their name (when the screen knows it). A person's id
   * ("user:usr_…", "usr_…") never shows: unknown, it's "Someone on the team". A log line's "Ana (person key_…)" is "Ana".
   */
  const actor = (raw, names = {}) => {
    if (raw == null || raw === '') return '';
    const s = String(raw);
    const id = /^(?:user:)?(usr_[A-Za-z0-9_-]+)$/.exec(s)?.[1];
    if (id) return names[id] || 'Someone on the team';
    const paren = /^(.*?) \((person|key) [A-Za-z0-9_-]+\)$/.exec(s);
    if (paren) return paren[2] === 'key' ? `${paren[1]} (a service key)` : paren[1];
    if (/^key_[A-Za-z0-9_-]+$/.test(s)) return 'A service key';
    if (/^(?:advertiser:)?adv_[A-Za-z0-9_-]+$/.test(s)) return 'An advertiser';
    if (s === 'demo seed') return 'Sample data';
    return s;
  };

  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const value = (k, v) => {
    if (Array.isArray(v)) return v.map((x) => value(k, x)).join(', ');
    if (typeof v === 'string' && ISO_TIME.test(v)) return when(v);
    if (k === 'role') return role(v);
    if (k === 'reason') return humanize(v);
    if (typeof v === 'string' && /^(?:usr|key|adv)_/.test(v)) return actor(v);
    if (typeof v === 'string' && /^[a-z][a-z0-9]*_[a-z0-9_]*$/.test(v)) return humanize(v);
    return v == null ? '' : String(v);
  };
  /** A security event's details, in words: "Role: Owner · Approves from: Nov 10, 7:42 PM". */
  const detail = (obj) => Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${DETAIL_KEYS[k] ?? humanize(k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())}: ${value(k, v)}`).join(' · ');

  const words = { STATUS, SKIP, EVENTS, humanize, status, skipReason, event, role, setZone, when, time, day, route, actor, detail };
  globalThis.fwWords = words;
})();

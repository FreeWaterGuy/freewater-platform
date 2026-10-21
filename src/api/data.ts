import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { categoryInfo, dataCategories, dataUse, preset, regionInfo } from '../modules/data/policy';
import { DataService } from '../modules/data/service';
import { tierNames } from '../modules/numberline/tiers';
import type { Placement } from '../modules/numberline/placement';
import { ApiError, obj, S, type RouteDef, Q } from './http';


/** The data switchboard, people's own data choices and rights, one person across roles, and the number line. */
export function dataRoutes(app: App, route: (r: RouteDef) => void) {
  const { data, numberline, platform } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
 /** The signed-in person behind a /v1/me request. Service keys (even admin ones, which also pass the 'me' scope) aren't people. */
  const me = (key: ApiKey | null) => {
    if (!key?.userId) throw new ApiError(403, 'person_required', 'Sign in as a person to do this; API keys belong to systems.');
    return { companyId: key.companyId, userId: key.userId, subject: `user:${key.userId}` };
  };
  const viewerKeyProp = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const choicesProp = obj(Object.fromEntries(dataCategories.map((k) => [k, S.bool])));

  // ---------- what's collected, and each person's own say ----------

  route({ method: 'GET', url: '/v1/public/data/:companyId', scope: 'public', summary: 'What a company collects, kind by kind, how long it keeps it, and which kinds it asks about first. Send ?viewer= to see this phone’s own choices.', handler: async (req) => {
    const id = (req.params as any).companyId;
    if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'Company not found.');
    const viewer = String((req.query as any).viewer ?? '');
    const known = /^[A-Za-z0-9_-]{8,64}$/.test(viewer);
    const place = data.placeOf(req);
    const rules = await data.rulesFor(id, known ? [viewer] : [], place);
    const p = rules.policy;
    return { body: {
      region: rules.region, companyRegion: data.policy(id).region, askFirst: rules.askFirst, minimumAge: rules.minimumAge, rewards: rules.rewards,
      doNotSell: known ? await data.doesNotSell(id, [viewer]) : false, use: dataUse,
      kinds: known ? await data.consents(id, viewer, place) : dataCategories.filter((k) => p.rules[k].collect).map((k) => ({ category: k, ...categoryInfo[k], asks: p.rules[k].consent, keepDays: p.rules[k].keepDays })),
    } };
  } });
  route({ method: 'POST', url: '/v1/public/data/:companyId/consent', scope: 'public', summary: 'This phone’s yes or no for each kind of data.', body: obj({ viewerKey: viewerKeyProp, choices: choicesProp }, ['viewerKey', 'choices']), handler: async (req) => {
    const b = req.body as any;
    const id = (req.params as any).companyId;
    if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'Company not found.');
    return { body: await data.consent(id, b.viewerKey, b.choices, 'scan page') };
  } });

  // ---------- how much each person shares: full, medium or lite ----------
  const levelProp = { type: 'string', enum: ['full', 'medium', 'lite'] };
  /** Choose a level; full earns its one-time points where that's allowed (once per person, across their phones). */
  const chooseLevel = async (companyId: string, subject: string, level: any, live: any, ip: string | undefined) => {
    await wrap(() => data.setLevel(companyId, subject, level, 'chosen'));
    let points = 0;
    if (level === 'full' && !subject.startsWith('bot_') && (await data.levelPaysHere(companyId, [subject], live))) {
      const person = (await data.personFor(companyId, subject).catch(() => null)) ?? subject;
      // Once per person: not if any of their phones or accounts (or the person) already earned it, under any reference.
      const subjects = [...new Set([subject, ...(await data.linkedSubjects(companyId, subject).catch(() => [] as string[]))])];
      const refs = [...new Set([person, ...subjects])].map((s) => `earn:data_full:${app.wallet.hidden(companyId, s)}`);
      const already = (await app.db.query(`select 1 from wallet_tx t where t.company_id = $1 and (t.ref = any($2) or (t.kind = 'earn:data_full' and exists (select 1 from wallet_lines l join wallet_holders h on l.account = 'holder:' || h.id and h.company_id = t.company_id where l.tx_id = t.id and h.subject = any($3)))) limit 1`, [companyId, refs, subjects])).rows.length > 0;
      // The network's daily limit applies too, so made-up phone keys from one place can't each collect it.
      if (!already) points = (await app.wallet.earn(companyId, subject, 'data_full', `data_full:${app.wallet.hidden(companyId, person)}`, { source: app.wallet.sourceOf(ip) })).points;
    }
    return { ...(await data.level(companyId, subject, live)), points };
  };
  route({ method: 'GET', url: '/v1/public/data/:companyId/level', scope: 'public', summary: 'How much this phone shares (full, medium or lite), what each means here, and whether to ask now (asked once). Send ?viewer=.', handler: async (req) => {
    const id = (req.params as any).companyId; const viewer = String((req.query as any).viewer ?? '');
    if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'Company not found.');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(viewer)) throw new ApiError(400, 'viewer', 'Send ?viewer=.');
    return { body: await data.level(id, viewer, data.placeOf(req)) };
  } });
  route({ method: 'POST', url: '/v1/public/data/:companyId/level', scope: 'public', summary: 'Choose how much this phone shares: full, medium or lite. Nothing works differently at any level; full earns a one-time points bonus where that’s allowed.', body: obj({ viewerKey: viewerKeyProp, level: levelProp }, ['viewerKey', 'level']), handler: async (req) => {
    const id = (req.params as any).companyId; const b = req.body as any;
    if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'Company not found.');
    return { body: await chooseLevel(id, b.viewerKey, b.level, data.placeOf(req), req.ip) };
  } });
  route({ method: 'GET', url: '/v1/me/data/level', scope: 'me', summary: 'How much you share: full, medium or lite.', handler: async (req, key) => ({ body: await data.level(me(key).companyId, me(key).subject, data.placeOf(req)) }) });
  route({ method: 'POST', url: '/v1/me/data/level', scope: 'me', summary: 'Choose how much you share: full, medium or lite.', body: obj({ level: levelProp }, ['level']), handler: async (req, key) => ({ body: await chooseLevel(me(key).companyId, me(key).subject, (req.body as any).level, data.placeOf(req), req.ip) }) });

  const company = (req: { params: unknown }) => { const id = (req.params as any).companyId as string; if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'Company not found.'); return id; };
  const placeProp = obj({ country: { type: 'string', pattern: '^[A-Za-z]{2}$' }, state: { type: 'string', pattern: '^[A-Za-z]{2,3}$' } }, ['country']);
  const ageProp = S.day;
  const detailsProp = obj({ zip: { type: ['string', 'null'], maxLength: 12 }, household: { type: ['integer', 'null'], minimum: 1, maximum: 20 }, language: { type: ['string', 'null'], maxLength: 35 } });
  const declared = (b: any) => ({ country: String(b.country).toUpperCase(), ...(b.state ? { state: String(b.state).toUpperCase() } : {}), source: 'declared' as const });

  route({ method: 'POST', url: '/v1/public/data/:companyId/place', scope: 'public', summary: 'Where this person says they live (country, and US state). Where they connect from counts too: whichever law is stricter applies.', body: obj({ viewerKey: viewerKeyProp, place: placeProp }, ['viewerKey', 'place']), handler: async (req) => {
    const id = company(req); const b = req.body as any;
    await data.notePlace(id, b.viewerKey, declared(b.place), 'declared');
    const r = await data.rulesFor(id, [b.viewerKey], data.placeOf(req));
    return { body: { region: r.region, askFirst: r.askFirst, minimumAge: r.minimumAge, rewards: r.rewards } };
  } });
  route({ method: 'POST', url: '/v1/public/data/:companyId/location', scope: 'public', summary: 'This phone’s exact position, shared by the person to see deals and machines near them. Optional; nothing is earned for sharing it (only choosing Full as a whole earns, once). Kept to about 10 meters, and only as long as the rules allow.', body: obj({ viewerKey: viewerKeyProp, lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 }, accuracyM: { type: 'number', minimum: 0, maximum: 100000 } }, ['viewerKey', 'lat', 'lng']), handler: async (req) => {
    const id = company(req); const b = req.body as any;
    return { body: await data.sharePreciseLocation(id, b.viewerKey, { lat: b.lat, lng: b.lng, accuracyM: b.accuracyM }, req) };
  } });
  route({ method: 'POST', url: '/v1/public/data/:companyId/age', scope: 'public', summary: 'Is this person old enough for the games and rewards where they are? Under the minimum age, only that answer is kept.', body: obj({ viewerKey: viewerKeyProp, birthDate: ageProp }, ['viewerKey', 'birthDate']), handler: async (req) => {
    const id = company(req); const b = req.body as any;
    return { body: await wrap(() => data.ageCheck(id, b.viewerKey, b.birthDate, data.placeOf(req))) };
  } });
  route({ method: 'POST', url: '/v1/public/data/:companyId/do-not-sell', scope: 'public', summary: '“Do not sell or share my personal information” for this phone. We never sell personal data; this also stops any sharing.', body: obj({ viewerKey: viewerKeyProp, on: S.bool }, ['viewerKey', 'on']), handler: async (req) => {
    const id = company(req); const b = req.body as any;
    return { body: await data.setDoNotSell(id, b.viewerKey, b.on, 'scan page') };
  } });

  route({ method: 'GET', url: '/v1/me/details', scope: 'me', summary: 'The optional things you told us: zip code, household size, language, and whether you’re old enough for the games.', handler: async (_req, key) => ({ body: await data.details(me(key).companyId, me(key).subject) }) });
  route({ method: 'POST', url: '/v1/me/details', scope: 'me', summary: 'Tell us your zip code, household size or language, if you like. All optional; send null to remove one.', body: detailsProp, handler: async (req, key) => ({ body: await wrap(() => data.setDetails(me(key).companyId, me(key).subject, req.body as any)) }) });
  route({ method: 'POST', url: '/v1/me/age', scope: 'me', summary: 'Your birthday, to check you’re old enough for the games and rewards where you are. Only the year is kept.', body: obj({ birthDate: ageProp }, ['birthDate']), handler: async (req, key) => ({ body: await wrap(() => data.ageCheck(me(key).companyId, me(key).subject, (req.body as any).birthDate, data.placeOf(req), { fromAccount: true })) }) });
  route({ method: 'POST', url: '/v1/me/place', scope: 'me', summary: 'Where you live (country, and US state).', body: obj({ place: placeProp }, ['place']), handler: async (req, key) => {
    await data.notePlace(me(key).companyId, me(key).subject, declared((req.body as any).place), 'declared');
    const r = await data.rulesFor(me(key).companyId, [me(key).subject], data.placeOf(req));
    return { body: { region: r.region, askFirst: r.askFirst, minimumAge: r.minimumAge, rewards: r.rewards } };
  } });
  route({ method: 'POST', url: '/v1/me/do-not-sell', scope: 'me', summary: '“Do not sell or share my personal information.”', body: obj({ on: S.bool }, ['on']), handler: async (req, key) => ({ body: await data.setDoNotSell(me(key).companyId, me(key).subject, (req.body as any).on, 'account') }) });

  route({ method: 'GET', url: '/v1/public/why/:unitId/:slot', scope: 'public', summary: '“Why am I seeing this?” What decided the ad on this bottle and what’s shown after scanning, in plain words. Send ?viewer= to include what this phone’s own choices allow.', handler: async (req) => {
    const { unitId, slot } = req.params as any;
    const unit = platform.units.get(unitId);
    if (!unit) throw new ApiError(404, 'not_found', 'No such bottle.');
    const pl = unit.placements.find((x) => x.slotIndex === Number(slot));
    const camp = pl ? platform.campaigns.get(pl.campaignId) : undefined;
    const loc = unit.locationId ? platform.locations.get(unit.locationId) : undefined;
    const viewer = String((req.query as any).viewer ?? '');
    const companyId = camp?.companyId ?? unit.companyId ?? '';
    const own = /^[A-Za-z0-9_-]{8,64}$/.test(viewer) && companyId ? await data.consents(companyId, viewer, data.placeOf(req)) : null;
    const on = (k: string) => !!own?.find((c) => c.category === k)?.on;
    const t = camp?.targeting ?? {};
    const reasons: string[] = [];
    if (unit.kind === 'custom') reasons.push('This is someone’s own custom bottle: they designed what’s on it.');
    else if (!camp || pl?.isHouse) reasons.push('This is the company’s own message: no advertiser bought this spot.');
    else {
      reasons.push(`${camp.advertiserName} paid for this spot on the bottle, so the bottle could be free.`);
      if (t.locations?.length) reasons.push(`They chose ${loc ? `${loc.name} in ${loc.city}` : 'certain machines'} as a place to show it.`);
      else if (loc) reasons.push(`The bottle came from ${loc.name} in ${loc.city}; this ad runs everywhere.`);
      if (t.products?.length || t.productCategories?.length) reasons.push('They chose this kind of drink to appear on.');
      if (t.audience) reasons.push('It was printed for a person whose account matches who the ad is for (for example, a delivery customer in a certain area). Bottles for nobody in particular never carry such ads.');
    }
    reasons.push('After scanning, the video you see first is picked by the time of day and whether you’ve scanned this ad before. You’ll see the same one again when you rescan.');
    if (own) reasons.push(on('interactions') ? 'What you watched and tapped before is used to pick videos you’ll like. You can turn that off.' : 'Nothing you did before is used to pick what you see: you turned that off, or your local law asks first.');
    return { body: { reasons, neverUsed: ['Your name, contacts or messages', 'What you do in other apps or websites', 'Data bought from anyone'], use: dataUse, yourChoices: companyId ? `/v1/public/data/${companyId}` : null } };
  } });

  route({ method: 'GET', url: '/v1/me/data', scope: 'me', summary: 'Everything kept about you, from every direction: your accounts, scans, page interactions, choices, designs, ads you made and what you did. Download it any time.', handler: async (_req, key) => ({ body: await data.profile(me(key).companyId, me(key).subject) }) });
  route({ method: 'GET', url: '/v1/me/data/choices', scope: 'me', summary: 'Your choices about each kind of data.', handler: async (_req, key) => ({ body: await data.consents(me(key).companyId, me(key).subject) }) });
  route({ method: 'POST', url: '/v1/me/data/choices', scope: 'me', summary: 'Say yes or no to each kind of data.', body: obj({ choices: choicesProp }, ['choices']), handler: async (req, key) => ({ body: await data.consent(me(key).companyId, me(key).subject, (req.body as any).choices, 'account') }) });
  // Sent in the body, never the address, so the phone's key stays out of links and logs.
  route({ method: 'POST', url: '/v1/public/data/:companyId/download', scope: 'public', summary: 'Without an account: everything kept under this phone’s random code (what it did, its choices, wallet, games, places and data choices). An account linked to the phone isn’t included: that takes signing in (GET /v1/me/data).', body: obj({ viewerKey: viewerKeyProp }, ['viewerKey']), handler: async (req) => {
    const companyId = company(req);
    return { body: await data.phoneData(companyId, (req.body as any).viewerKey) };
  } });
  route({ method: 'POST', url: '/v1/public/data/:companyId/forget', scope: 'public', summary: 'Without an account: erase what’s kept under this phone’s random code (what it did on pages, its choices, consents). Scans stay in the books as counts; the phone gets a new code. An account linked to the phone isn’t touched: that takes signing in.', body: obj({ viewerKey: viewerKeyProp }, ['viewerKey']), handler: async (req) => {
    const companyId = (req.params as any).companyId as string;
    if (!app.platform.companies.has(companyId)) throw new ApiError(404, 'not_found', 'No such company.');
    return { body: await data.erase(companyId, (req.body as any).viewerKey, { followLinks: false }) };
  } });
  route({ method: 'DELETE', url: '/v1/me/data', scope: 'me', summary: 'Erase what’s kept about you. Money records stay in the books, as the law requires, with your name taken out.', handler: async (_req, key) => ({ body: await data.erase(me(key).companyId, me(key).subject) }) });
  route({ method: 'POST', url: '/v1/me/link-device', scope: 'me', summary: 'This phone’s scans belong to you: join what it did before you signed in to your account (as your data choices allow).', body: obj({ viewerKey: viewerKeyProp }, ['viewerKey']), handler: async (req, key) => {
    const { companyId, userId, subject } = me(key);
    const viewerKey = (req.body as any).viewerKey as string;
    // The key is the proof (only that phone's browser has it); never a phone already someone else's, nor an unused key
    // (see DataService.mayLinkDevice).
    if (!(await data.mayLinkDevice(companyId, userId, viewerKey))) throw new ApiError(409, 'not_your_phone', 'That phone can’t be joined to your account. Open this page on the phone itself and try again.');
    return { body: { person: await data.link(companyId, [subject, viewerKey], 'signed in on this phone') } };
  } });
  route({ method: 'POST', url: '/v1/me/stance', scope: 'me', summary: 'How you feel about the cause your bottles support, and about ads. Only used so the platform counts what you really get (the User Test).', body: obj({ cause: { type: 'string', enum: ['supports', 'indifferent', 'opposes'] }, ads: { type: 'string', enum: ['welcome', 'unwelcome'] } }), handler: async (req, key) => {
    const b = req.body as any;
    await app.db.query(`update users set consents = consents || $2::jsonb where id = $1`, [me(key).userId, JSON.stringify({ ...(b.cause ? { causeStance: b.cause } : {}), ...(b.ads ? { adsStance: b.ads } : {}) })]);
    return { body: { saved: true } };
  } });

  // ---------- the company's side ----------

  route({ method: 'GET', url: '/v1/data/policy', scope: ['admin', 'ledger'], summary: 'Your data switchboard, and the presets for each country.', handler: async (_req, key) => ({ body: { policy: data.policy(staff(key).companyId), presets: Object.fromEntries((Object.keys(regionInfo) as (keyof typeof regionInfo)[]).map((r) => [r, { about: regionInfo[r], policy: preset(r) }])), kinds: categoryInfo } }) });
  route({ method: 'GET', url: '/v1/data/people', query: { email: Q.text, phone: Q.text, user: Q.text, viewer: Q.text, person: Q.text }, scope: ['admin', 'ledger'], summary: 'Find one person, by email, phone, account or phone id, with everything from every direction: consumer and advertiser, merged.', handler: async (req, key) => {
    const k = staff(key).companyId;
    const q = req.query as any;
    const subject = q.email ? DataService.emailKey(q.email) : q.phone ? DataService.phoneKey(q.phone) : q.user ? `user:${q.user}` : q.viewer ? String(q.viewer) : q.person ? String(q.person) : '';
    if (!subject) throw new ApiError(400, 'what', 'Send ?email=, ?phone=, ?user=, ?viewer= or ?person=.');
    // A phone's key opens its wallet: the team sees a fingerprint of it, never the key (R15).
    return { body: data.forTeam(await data.profile(k, subject), q.viewer ? [String(q.viewer)] : []) };
  } });
  route({ method: 'GET', url: '/v1/data/machines', query: { days: Q.count }, scope: ['admin', 'ledger'], summary: 'What works at each machine, from counts only (no one’s personal data): scans and AR by kind of ad and time of day, last ?days= (default 30).', handler: async (req, key) => ({ body: await data.machineLearning(staff(key).companyId, Math.min(365, Math.max(1, Number((req.query as any).days ?? 30) || 30))) }) });
  route({ method: 'POST', url: '/v1/data/purge', scope: 'admin', summary: 'Delete everything older than your settings keep (it also runs daily).', handler: async (_req, key) => { staff(key); return { body: { deleted: await data.purge() } }; } });

  // ---------- the number line ----------

  route({ method: 'GET', url: '/v1/numberline', scope: ['admin', 'ledger', 'campaigns'], summary: 'Everything placed on the number line: for sale, free (from outside, or ad-funded) or negatively priced, which economic systems it runs on (a blend has shares), where its money comes from, and why.', handler: async (_req, key) => {
    const k = key!;
    const rows = await numberline.all(k.companyId);
    return { body: k.advertiserId ? rows.filter((r) => r.subject.startsWith('offering:') && platform.campaigns.get(r.subject.slice(9))?.advertiserId === k.advertiserId) : rows };
  } });
  route({ method: 'POST', url: '/v1/numberline/place', scope: ['admin', 'campaigns'], summary: 'Place something now: bottle:<product>, custom, company or offering:<campaign>. The number-line agent places it and keeps the reasons.', body: obj({ subject: { type: 'string', maxLength: 120 } }, ['subject']), handler: async (req, key) => {
    const s = (req.body as any).subject as string;
    if (key!.advertiserId && !(s.startsWith('offering:') && platform.campaigns.get(s.slice(9))?.advertiserId === key!.advertiserId)) throw new ApiError(403, 'missing_scope', 'Advertisers can place only their own offerings.');
    return { body: await wrap(async () => { const p = await numberline.place(key!.companyId, s); return { subject: s, id: p.id, by: p.by, status: p.status, placement: p.placement }; }) };
  } });
  route({ method: 'GET', url: '/v1/numberline/history', query: { subject: Q.text }, scope: ['admin', 'ledger'], summary: 'Every version of one placement, who made it and why.', handler: async (req, key) => ({ body: await numberline.history(staff(key).companyId, String((req.query as any).subject ?? '')) }) });
  // A correction is a whole placement, as /v1/numberline/history shows it: anything less is refused before it is kept
  // (an empty one used to crash the save, and a partial one would break every page that reads it back).
  const system = { type: 'string', enum: ['market', 'sharing', 'free_outside', 'free_ad', 'giving', 'public'] };
  const cents = { type: 'number', minimum: -100_000_000, maximum: 100_000_000 };
  const placement = obj({
    netCents: cents, position: { type: 'string', enum: ['for_sale', 'free', 'negatively_priced'] }, freeKind: { type: 'string', enum: ['outside_funded', 'ad_funded'] },
    systems: { type: 'array', minItems: 1, maxItems: 6, items: obj({ system, share: { type: 'number', minimum: 0, maximum: 1 } }, ['system', 'share']) },
    primary: system,
    funding: { type: 'array', maxItems: 7, items: { type: 'string', enum: ['user_payment', 'lower_floor', 'native_output', 'adjacent_capture', 'participant_value', 'outside_grant', 'peer_payment'] } },
    valueBack: obj({ donationCents: cents, paymentCents: cents, cause: { type: 'string', maxLength: 200 }, directedBy: { type: 'string', enum: ['operator', 'person', 'none'] } }, ['donationCents', 'paymentCents', 'directedBy']),
    conditions: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 } },
    reasons: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  }, ['netCents', 'position', 'systems', 'primary', 'funding', 'valueBack', 'conditions', 'reasons', 'confidence']);
  route({ method: 'POST', url: '/v1/numberline/override', scope: 'admin', summary: 'Correct a placement. Kept as a new version with who made it.', body: obj({ subject: { type: 'string', maxLength: 120 }, placement }, ['subject', 'placement']), handler: async (req, key) => {
    const b = req.body as { subject: string; placement: Placement };
    return { body: await wrap(() => numberline.override(staff(key).companyId, b.subject, b.placement, `person:${key!.userId ?? key!.id}`)) };
  } });
  route({ method: 'GET', url: '/v1/honest-data', scope: ['admin', 'ledger'], summary: 'Every choice people made, sorted into the honest-data tiers and by economic system (market, sharing, free, giving, public), last 30 days.', handler: async (_req, key) => {
    await numberline.idle();
    return { body: { tiers: tierNames, ...(await numberline.summary(staff(key).companyId)) } };
  } });
  route({ method: 'GET', url: '/v1/honest-data/choices', query: { tier: Q.text, system: Q.text, person: Q.text, limit: Q.count }, scope: ['admin', 'ledger'], summary: 'The choices themselves, filtered by ?tier=, ?system= or ?person=.', handler: async (req, key) => {
    await numberline.idle();
    const q = req.query as any;
    return { body: await numberline.choices(staff(key).companyId, { tier: q.tier, system: q.system, person: q.person, limit: q.limit ? Number(q.limit) : undefined }) };
  } });
}

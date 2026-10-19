import { placementShare } from '../modules/ads/layouts';
import { createHash } from 'node:crypto';
import type { App } from '../app';
import type { ApiKey } from '../db/store';
import type { Unit } from '../core/types';
import { newId } from '../core/ids';
import { isEligible } from '../modules/ads/engine';
import { svgCreative } from '../modules/print/svgCreative';
import { givingLine, PX_PER_IN } from '../modules/print/renderer';
import { MachinePresence } from '../modules/machines/presence';
import { DesignService } from '../modules/custom/service';
import { ApiError, notFound, obj, S, type RouteDef } from './http';

/**
 * What the FreeWater app uses: machines near you, one-tap free water, the countdown, your bottles,
 * and designing, approving and paying for your own bottle.
 */
export function consumerRoutes(app: App, route: (r: RouteDef) => void, h: { me: (key: ApiKey | null) => string; checkExperience: (id: string, config: unknown, theme: unknown) => void }) {
  const { platform, registry, experiences } = app;
  const presence = new MachinePresence(app.db, () => platform.bus.now());
  const rules = (companyId: string) => platform.companies.get(companyId)!.consumer ?? { freeBottlesPerDay: 3, retailValueCents: 100 };

  const machine = (id: string, companyId?: string) => {
    const l = platform.locations.get(id);
    if (!l || l.kind !== 'machine') throw notFound('Machine');
    const company = companyOfLocation(id);
    if (!company || (companyId && company !== companyId)) throw notFound('Machine');
    return { location: l, companyId: company };
  };
  const companyOfLocation = (locationId: string) => platform.locations.get(locationId)?.companyId;

  const machineView = (id: string) => {
    const { location: l, companyId } = machine(id);
    const company = platform.companies.get(companyId)!;
    return {
      id: l.id, name: l.name, city: l.city, address: l.address ?? null, lat: l.lat ?? null, lng: l.lng ?? null,
      company: company.name, companyId, printSeconds: l.printSeconds ?? 30,
      pricing: company.consumerPricing, customPriceCents: company.prices.customUnit,
      giving: givingLine(company, l.id), freeBottlesPerDay: rules(companyId).freeBottlesPerDay,
      sampleLabelUrl: `/v1/public/machines/${l.id}/sample.svg`,
      model6: app.fleet.isModel6(l.id), availability: app.fleet.availability(l.id),
    };
  };

  const isMine = (u: Unit, userId: string) => u.consumerId === userId || (u.kind === 'custom' && u.ownerId === userId);
  const bottleView = (u: Unit) => {
    const company = platform.companies.get(u.companyId)!;
    const loc = platform.locations.get(u.locationId);
    const r = platform.ledger.receipt(u.id);
    return {
      id: u.id, kind: u.kind, status: u.status, createdAt: u.createdAt,
      place: loc ? `${loc.id}, ${loc.name}` : u.locationId,
      labelUrl: `/v1/me/bottles/${u.id}/label.svg`,
      receiptUrl: `/r/${u.id}`,
      earnedCents: r.earned.total, donatedCents: r.donatedCents, giving: givingLine(company, u.locationId),
      ads: u.kind === 'custom'
        ? [{ slot: 0, name: 'Your message', share: 1, size: 'Full label', url: `/s/${u.id}/0`, ar: false, experience: 'Custom bottle', isHouse: false }]
        : u.placements.map((p) => {
            const c = platform.campaigns.get(p.campaignId);
            const info = experiences.host.info(c?.experienceId ?? p.experienceId);
            return { slot: p.slotIndex, name: p.advertiserName, share: placementShare(p), size: placementShare(p) === 1 ? 'Full label' : `1/${placementShare(p)}`, url: `/s/${u.id}/${p.slotIndex}`, ar: !!info?.ar, experience: info?.name ?? 'Page', isHouse: p.isHouse };
          }),
    };
  };

  /** An ad for the countdown screen. For an ad-paid bottle, its own biggest ad; for a paid custom bottle, any ad that may run there. */
  const countdownAd = (u: Unit) => {
    const company = platform.companies.get(u.companyId)!;
    const own = [...u.placements].filter((p) => !p.isHouse).sort((a, b) => placementShare(a) - placementShare(b))[0];
    const eligible = [...platform.campaigns.values()].filter((c) => isEligible(c, company, u.locationId)).sort((a, b) => a.id.localeCompare(b.id));
    const pick = own ? platform.campaigns.get(own.campaignId) : eligible[Math.floor(platform.random() * eligible.length)];
    const c = pick ?? [...platform.campaigns.values()].find((x) => x.isHouse && x.companyId === company.id);
    if (!c) return null;
    return { advertiser: c.advertiserName, campaignId: c.id, art: `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="440" viewBox="0 0 360 440">${c.creative.svg(360, 440)}</svg>`, onThisBottle: !!own, url: own ? `/s/${u.id}/${own.slotIndex}` : null, target: own ? `s:${u.id}:${own.slotIndex}` : null };
  };

  const limitCheck = (userId: string, companyId: string) => {
    const max = rules(companyId).freeBottlesPerDay;
    const since = platform.bus.now().getTime() - 24 * 3600 * 1000;
    const recent = [...platform.units.values()].filter((u) => u.consumerId === userId && u.kind === 'ad_supported' && u.status !== 'failed' && Date.parse(u.createdAt) >= since).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (recent.length >= max) {
      const next = new Date(Date.parse(recent[recent.length - max]!.createdAt) + 24 * 3600 * 1000);
      throw new ApiError(429, 'daily_limit', `You've had your ${max} free bottles for today. Your next one is ready after ${next.toISOString()}.`);
    }
    return max - recent.length;
  };

  // ---------- public ----------

  route({ method: 'GET', url: '/v1/public/app-config', scope: 'public', summary: 'Which company this app is for, its brand, and which web addresses its QR codes use.', handler: async (req) => {
    const id = String((req.query as any).company ?? process.env.APP_COMPANY ?? 'freewater');
    const company = platform.companies.get(id);
    if (!company) throw notFound('Company');
    let host = '';
    try { host = new URL(company.receiptBaseUrl).host; } catch {}
    return { body: { companyId: company.id, name: company.name, brand: company.brand, hosts: host ? [host] : [] } };
  } });

  route({ method: 'GET', url: '/v1/public/companies/:companyId/machines', scope: 'public', summary: "A company's machines, for the map.", handler: async (req) => {
    const id = (req.params as any).companyId;
    if (!platform.companies.has(id)) throw notFound('Company');
    return { body: [...platform.locations.values()].filter((l) => l.kind === 'machine' && companyOfLocation(l.id) === id).map((l) => machineView(l.id)) };
  } });
  route({ method: 'GET', url: '/v1/public/machines/:locationId', scope: 'public', summary: 'One machine: where it is, what it costs, what it gives.', handler: async (req) => ({ body: machineView((req.params as any).locationId) }) });

  const samples = new Map<string, { at: number; svg: string }>();
  route({ method: 'GET', url: '/v1/public/machines/:locationId/sample.svg', scope: 'public', summary: 'A sample label for this machine, filled the way a real one would be. Nothing is printed or billed.', handler: async (req) => {
    const { location, companyId } = machine((req.params as any).locationId);
    const hit = samples.get(location.id);
    if (hit && platform.bus.now().getTime() - hit.at < 5 * 60_000) return { type: 'image/svg+xml', raw: hit.svg };
    const company = platform.companies.get(companyId)!;
    const product = platform.standardProduct(companyId);
    const fill = registry.adsFor(company).fill({ company, product, location, campaigns: [...platform.campaigns.values()], random: platform.random });
    const unit: Unit = { id: 'sample', companyId, productId: product.id, locationId: location.id, kind: 'ad_supported', placements: fill.placements, layout: fill.layout, status: 'rendered', createdAt: platform.bus.now().toISOString() };
    const label = await registry.rendererFor(company).render({ unit, product, company, campaigns: platform.campaigns });
    samples.set(location.id, { at: platform.bus.now().getTime(), svg: label.svg });
    return { type: 'image/svg+xml', raw: label.svg };
  } });

  route({ method: 'GET', url: '/v1/public/products/:productId', scope: 'public', summary: 'A product and the size of the area a custom design fills.', handler: async (req) => {
    const p = platform.products.get((req.params as any).productId);
    if (!p) throw notFound('Product');
    const art = { widthIn: +(p.label.widthIn - p.label.seamIn - p.label.panelWidthIn).toFixed(3), heightIn: p.label.heightIn };
    return { body: { id: p.id, name: p.name, label: { widthIn: p.label.widthIn, heightIn: p.label.heightIn }, designArea: { ...art, widthPx: Math.round(art.widthIn * PX_PER_IN), heightPx: Math.round(art.heightIn * PX_PER_IN) } } };
  } });

  // ---------- machines ----------

  route({ method: 'GET', url: '/v1/machines/:locationId/presence', scope: 'orders', summary: "The code the machine's screen shows right now, so people at the machine can order from their phone. It changes every 30 seconds.", handler: async (req, key) => {
    const { location } = machine((req.params as any).locationId, key!.companyId);
    const c = await presence.current(location.id);
    const company = platform.companies.get(key!.companyId)!;
    return { body: { ...c, url: `${company.receiptBaseUrl.replace(/\/$/, '')}/app/m/${location.id}?c=${c.code}` } };
  } });

  // ---------- people ----------

  const atMachine = async (locationId: string, code: string | undefined, companyId: string) => {
    machine(locationId, companyId);
    if (!code || !(await presence.check(locationId, code))) throw new ApiError(403, 'not_at_machine', "Scan the code on the machine's screen to get a bottle there. It changes every 30 seconds.");
  };

  const freeLeft = (userId: string, companyId: string) => Math.max(0, rules(companyId).freeBottlesPerDay - [...platform.units.values()].filter((u) => u.consumerId === userId && u.kind === 'ad_supported' && u.status !== 'failed' && Date.parse(u.createdAt) >= platform.bus.now().getTime() - 864e5).length);
  const vendState = (u: Unit) => (u.status === 'dispensed' || u.status === 'printed' ? 'ready' : u.status === 'failed' ? 'failed' : 'printing');
  const vendView = (u: Unit, userId: string) => {
    const loc = platform.locations.get(u.locationId)!;
    const state = vendState(u);
    return { status: state, ...(state === 'failed' ? { message: "The machine couldn't print your bottle. Nothing was used up; try again." } : {}), bottle: bottleView(u), countdown: { seconds: loc.printSeconds ?? 30, ad: countdownAd(u) }, freeLeftToday: freeLeft(userId, u.companyId) };
  };

  route({ method: 'POST', url: '/v1/me/vends', scope: 'me', summary: 'Get my free water: one tap at a machine. Send the code from its screen. At a Model 6 the answer comes straight away with status "printing"; check GET /v1/me/vends/{vendId} until it is "ready".', body: obj({ vendId: S.str, locationId: S.str, presenceCode: S.str, productId: S.str, choiceSetId: S.str }, ['vendId', 'locationId', 'presenceCode']), handler: async (req, key) => {
    const userId = h.me(key);
    const b = req.body as any;
    const orderId = `vend:${userId}:${b.vendId}`;
    const existing = [...platform.units.values()].find((u) => u.companyId === key!.companyId && u.orderId === orderId);
    if (existing) return { status: existing.status === 'failed' ? 422 : 200, body: existing.status === 'failed' ? { error: { code: 'print_failed', message: vendView(existing, userId).message } } : vendView(existing, userId) };
    await atMachine(b.locationId, b.presenceCode, key!.companyId);
    limitCheck(userId, key!.companyId);
    const a = app.fleet.availability(b.locationId);
    if (a.state !== 'ready') throw new ApiError(409, `machine_${a.state}`, a.message);
    const stocked = platform.locations.get(b.locationId)?.products;
    const productId = b.productId ?? stocked?.[0] ?? platform.standardProduct(key!.companyId).id;
    if (!platform.products.has(productId)) throw new ApiError(422, 'unknown_product', `Product ${productId} doesn't exist.`);
    if (stocked && !stocked.includes(productId)) throw new ApiError(422, 'not_stocked', `This machine doesn't have that. It has: ${stocked.map((id) => platform.products.get(id)?.name ?? id).join(', ')}.`);
    // The bottle is printed for this person: ads that target people can be chosen, and their first scan confirms it reached them.
    const audience = await app.accounts.audienceFor(userId, key!.companyId);
    const running = platform.order({ companyId: key!.companyId, orderId, locationId: b.locationId, productId, consumerId: userId, audience });
    // Chosen from this machine's options (shown in a random order, no ads on the choosing): recorded as that choice,
    // once the bottle is actually printed.
    if (b.choiceSetId && audience) void running.then((o) => (o.ok ? app.environment.choose(b.choiceSetId, `bottle:${productId}`, audience.personKey, orderId, `machine:${b.locationId}`) : null)).catch(() => {});
    // A Model 6 takes a while to print: answer now and let the app watch the countdown.
    const r = await Promise.race([running, new Promise<null>((res) => setTimeout(() => res(null), app.fleet.isModel6(b.locationId) ? 1500 : 60_000))]);
    if (r && !r.ok) return { status: 422, body: { error: { code: 'print_failed', message: "The machine couldn't print your bottle. Nothing was used up; try again." } } };
    const unit = r?.unit ?? [...platform.units.values()].find((u) => u.companyId === key!.companyId && u.orderId === orderId)!;
    return { status: r ? 201 : 202, body: vendView(unit, userId) };
  } });

  route({ method: 'GET', url: '/v1/me/machines/:locationId/choice', scope: 'me', summary: 'What this machine has to choose from, in a random order with no ads or paid places. Send the choiceSetId with the vend. Null when it has one product.', handler: async (req, key) => {
    const userId = h.me(key);
    const audience = await app.accounts.audienceFor(userId, key!.companyId);
    if (!audience) throw new ApiError(404, 'not_found', 'No such account.');
    try { return { body: await app.environment.machineChoice(key!.companyId, audience.personKey, (req.params as any).locationId) }; }
    catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; }
  } });

  route({ method: 'GET', url: '/v1/me/vends/:vendId', scope: 'me', summary: 'How a bottle you asked for is going: printing, ready (in the tray) or failed (nothing was used up).', handler: async (req, key) => {
    const userId = h.me(key);
    const u = [...platform.units.values()].find((x) => x.companyId === key!.companyId && x.orderId === `vend:${userId}:${(req.params as any).vendId}`);
    if (!u) throw notFound('Vend');
    return { body: vendView(u, userId) };
  } });

  route({ method: 'GET', url: '/v1/me/bottles', scope: 'me', summary: 'Your bottles, newest first, with what they gave and what you saved.', handler: async (_req, key) => {
    const userId = h.me(key);
    const mine = [...platform.units.values()].filter((u) => isMine(u, userId) && (u.status === 'dispensed' || u.status === 'printed')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const views = mine.map(bottleView);
    const free = mine.filter((u) => u.kind === 'ad_supported').length;
    return { body: { stats: { bottles: mine.length, donatedCents: views.reduce((s, b) => s + b.donatedCents, 0), savedCents: free * rules(key!.companyId).retailValueCents }, bottles: views.slice(0, 50) } };
  } });
  const myBottle = (key: ApiKey | null, id: string) => {
    const u = platform.units.get(id);
    if (!u || !isMine(u, h.me(key))) throw notFound('Bottle');
    return u;
  };
  route({ method: 'GET', url: '/v1/me/bottles/:id', scope: 'me', summary: 'One of your bottles: its ads, their AR, and its receipt.', handler: async (req, key) => ({ body: bottleView(myBottle(key, (req.params as any).id)) }) });
  route({ method: 'GET', url: '/v1/me/bottles/:id/label.svg', scope: 'me', summary: "Your bottle's label, as printed.", handler: async (req, key) => {
    const svg = await platform.labelSvg(myBottle(key, (req.params as any).id).id);
    if (!svg) throw notFound('Label');
    return { type: 'image/svg+xml', raw: svg };
  } });

  // ---------- design your own: approve the proof, then pay and print ----------

  route({ method: 'POST', url: '/v1/me/proofs', scope: 'me', summary: 'Show me exactly what will print. Returns the full label, with the company panel and QR codes, and the price. Only an approved proof can be printed.', body: obj({ productId: S.str, svg: { type: 'string', minLength: 1, maxLength: 2_000_000 }, experience: { type: 'object' } }, ['productId', 'svg']), handler: async (req, key) => {
    const userId = h.me(key);
    const b = req.body as any;
    const product = platform.products.get(b.productId);
    if (!product) throw new ApiError(422, 'unknown_product', `Product ${b.productId} doesn't exist.`);
    let art;
    try { art = svgCreative(b.svg); } catch (e: any) { throw new ApiError(422, 'artwork_refused', e.message); }
    if (b.experience) h.checkExperience('custom-experience', b.experience, undefined);
    const company = platform.companies.get(key!.companyId)!;
    const id = newId('pf');
    const unit: Unit = { id, companyId: company.id, productId: product.id, locationId: 'proof', kind: 'custom', ownerId: userId, placements: [], layout: [6], status: 'rendered', createdAt: platform.bus.now().toISOString() };
    const label = await registry.rendererFor(company).render({ unit, product, company, campaigns: platform.campaigns, customArt: art });
    const sha = createHash('sha256').update(b.svg).update(JSON.stringify(b.experience ?? null)).update(product.id).digest('hex');
    const expires = new Date(platform.bus.now().getTime() + 24 * 3600 * 1000);
    await app.db.query(`insert into proofs (id, user_id, company_id, product_id, design_sha256, design_svg, experience, label_svg, price_cents, created_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, userId, company.id, product.id, sha, b.svg, b.experience ? JSON.stringify(b.experience) : null, label.svg, company.prices.customUnit, platform.bus.now().toISOString(), expires.toISOString()]);
    return { status: 201, body: { proofId: id, labelSvg: label.svg, priceCents: company.prices.customUnit, expiresAt: expires.toISOString(), note: 'This is exactly what will print. The QR codes on the proof are samples; your bottle gets its own.' } };
  } });

  route({ method: 'POST', url: '/v1/me/custom-orders', scope: 'me', summary: 'Print a design you approved. Money is held first, taken only once it prints, and released if it does not.', body: obj({ orderId: S.str, proofId: S.str, locationId: S.str, presenceCode: S.str }, ['orderId', 'proofId', 'locationId', 'presenceCode']), handler: async (req, key) => {
    const userId = h.me(key);
    const b = req.body as any;
    const company = platform.companies.get(key!.companyId)!;
    const proof = (await app.db.query<any>(`select * from proofs where id = $1 and user_id = $2`, [b.proofId, userId])).rows[0];
    if (!proof) throw new ApiError(422, 'proof_required', 'Review and approve your proof before printing.');
    if (new Date(proof.expires_at).getTime() < platform.bus.now().getTime()) throw new ApiError(422, 'proof_expired', 'That proof is more than a day old. Review it again before printing.');
    const orderId = `${userId}:${b.orderId}`;
    const already = [...platform.units.values()].some((u) => u.companyId === company.id && u.orderId === orderId);
    if (!already) await atMachine(b.locationId, b.presenceCode, company.id);
    const experience = proof.experience ? (typeof proof.experience === 'string' ? JSON.parse(proof.experience) : proof.experience) : undefined;
    const bottles = DesignService.bottlesOf(proof, app.designs.designArea());
    const price = Number(proof.price_cents); // the price shown on the proof, set by the server
    const hold = await app.payments.authorize({ companyId: company.id, ownerType: 'user', ownerId: userId, amountCents: price * bottles.length, purpose: 'custom_order', ref: b.orderId, idempotencyKey: `custom:${company.id}:${userId}:${b.orderId}`, description: `${bottles.length} custom ${proof.product_id}` });
    if (hold.status === 'declined') return { status: 402, body: { error: { code: 'card_declined', message: `${hold.failure} Nothing was printed or charged.` } } };
    // Print them one after another. Only the bottles that print are paid for.
    const printed: Unit[] = [];
    for (let i = 0; i < bottles.length; i++) {
      const r = await platform.order({ companyId: company.id, orderId: i === 0 ? orderId : `${orderId}:${i + 1}`, locationId: b.locationId, productId: proof.product_id, consumerId: userId, custom: { customerId: userId, art: svgCreative(bottles[i]!), priceCents: price, experienceConfig: experience } });
      if (r.ok) printed.push(r.unit);
    }
    if (!printed.length) {
      const voided = await app.payments.void(hold.id);
      return { status: 422, body: { error: { code: 'print_failed', message: 'It did not print, so the hold on your card was released. Nothing was charged.' }, payment: voided } };
    }
    const paid = hold.status === 'captured' ? hold : await app.payments.capture(hold.id, price * printed.length);
    if (proof.design_id) await app.designs.markOrdered(proof.design_id);
    const loc = platform.locations.get(b.locationId)!;
    const short = bottles.length - printed.length;
    return { status: 201, body: { bottle: bottleView(printed[0]!), bottles: printed.map(bottleView), payment: paid, ...(short ? { notice: `${short} of ${bottles.length} didn't print, so you were only charged for ${printed.length}.` } : {}), countdown: { seconds: (loc.printSeconds ?? 30) * printed.length, ad: countdownAd(printed[0]!) } } };
  } });

  // ---------- designing by chatting ----------

  route({ method: 'POST', url: '/v1/me/assets', scope: 'me', summary: 'Upload a photo or a video for your own bottle. Send the file itself as the body with its Content-Type.', rawBodyLimit: 16 * 1024 * 1024, handler: async (req, key) => {
    const userId = h.me(key);
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!Buffer.isBuffer(req.body) || type === 'model/gltf-binary') throw new ApiError(415, 'unsupported_type', 'Upload a photo (PNG, JPEG, WebP) or a video (MP4).');
    const asset = await app.assets.put({ companyId: key!.companyId, userId, contentType: type, bytes: new Uint8Array(req.body), name: typeof (req.query as any).name === 'string' ? (req.query as any).name : undefined });
    return { status: 201, body: asset };
  } });
  route({ method: 'POST', url: '/v1/me/designs', scope: 'me', summary: 'Start designing your own bottle in the chat.', handler: async (_req, key) => ({ status: 201, body: await app.designs.create(key!.companyId, h.me(key)) }) });
  route({ method: 'GET', url: '/v1/me/designs', scope: 'me', summary: 'Your designs.', handler: async (_req, key) => ({ body: await app.designs.list(h.me(key)) }) });
  route({ method: 'GET', url: '/v1/me/designs/:id', scope: 'me', summary: 'A design, its live preview and the conversation.', handler: async (req, key) => ({ body: await app.designs.get((req.params as any).id, h.me(key)) }) });
  const designFile = { type: 'object', additionalProperties: false, properties: { dataUrl: { type: 'string', maxLength: 1_600_000, pattern: '^data:image/(png|jpeg|webp);base64,' }, assetId: S.str, name: { type: 'string', maxLength: 120 } } };
  route({ method: 'POST', url: '/v1/me/designs/:id/messages', scope: 'me', summary: 'Tell the designer what you want, with photos (as data) or videos (uploaded first). It changes the design and answers.', body: obj({ text: { type: 'string', maxLength: 2000 }, attachments: { type: 'array', maxItems: 6, items: designFile } }, ['text']), handler: async (req, key) => {
    const b = req.body as any;
    if (!b.text.trim() && !(b.attachments ?? []).length) throw new ApiError(400, 'empty', 'Say something or attach a photo.');
    return { body: await app.designs.chat({ id: (req.params as any).id, userId: h.me(key), text: b.text, attachments: b.attachments ?? [] }) };
  } });
  route({ method: 'GET', url: '/v1/me/designs/:id/scan-preview', scope: 'me', summary: 'What scanning your bottle will open.', handler: async (req, key) => ({ body: await app.designs.scanPreview((req.params as any).id, h.me(key)) }) });
  route({ method: 'POST', url: '/v1/me/designs/:id/proof', scope: 'me', summary: 'Make the proof: the full label exactly as it prints, and the price for every bottle.', handler: async (req, key) => ({ status: 201, body: await app.designs.proof((req.params as any).id, h.me(key)) }) });

  return { presence };
}

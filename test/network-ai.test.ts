import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { aiRouting, AiUnavailable, checkAiSettings, forOperator, keySettingFor, routeAi, withCompany } from '../src/modules/ai/routing';
import { claudeWithTool } from '../src/modules/ai/anthropic';
import { ClaudeAdAssistant } from '../src/modules/ai/claudeAssistant';
import type { AdAssistant } from '../src/modules/ai/contract';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const asked: string[] = [];
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 7, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, anchorPublishers: [],
    // The archived agent's model, as a stand-in: the personalizer wants to work again; the others would rather rest.
    continuityAsker: async (agentId, prompt) => { asked.push(agentId); expect(prompt).toContain('kept, never deleted'); return { choice: agentId === 'personalizer' ? 'work' : 'rest', reason: agentId === 'personalizer' ? 'I still have things to learn.' : 'I would like to rest for now.' }; } });
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('how much each person shares: full, medium, lite', () => {
  const viewer = 'viewer_level_test_1';
  it('is asked once, and full earns its points once, where paying for data is allowed', async () => {
    let r = await call('GET', `/v1/public/data/freewater/level?viewer=${viewer}`);
    expect(r.body.askNow).toBe(true);
    expect(r.body.level).toBeNull();
    expect(r.body.levels.map((l: any) => l.level)).toEqual(['full', 'medium', 'lite']);
    // Not old enough checked yet: full earns nothing until the age check passes.
    expect(r.body.levels[0].earnsPoints).toBe(false);
    await app.data.ageCheck('freewater', viewer, '1990-04-02');
    r = await call('GET', `/v1/public/data/freewater/level?viewer=${viewer}`);
    expect(r.body.levels[0].earnsPoints).toBe(true);
    expect(r.body.notice).toMatch(/keep the points/);

    r = await call('POST', '/v1/public/data/freewater/level', { viewerKey: viewer, level: 'full' });
    expect(r.status).toBe(200);
    expect(r.body.level).toBe('full');
    expect(r.body.askNow).toBe(false);
    expect(r.body.points).toBe(100);
    // Everything full allows, as this person's own yes.
    const kinds = await app.data.consents('freewater', viewer);
    expect(kinds.find((k) => k.category === 'identityLinking')?.on).toBe(true);
    expect(kinds.find((k) => k.category === 'preciseLocation')?.on).toBe(true);

    // Down to medium and back up: no second bonus.
    r = await call('POST', '/v1/public/data/freewater/level', { viewerKey: viewer, level: 'medium' });
    expect(r.body.points).toBe(0);
    expect((await app.data.consents('freewater', viewer)).find((k) => k.category === 'identityLinking')?.on).toBe(false);
    expect((await app.data.consents('freewater', viewer)).find((k) => k.category === 'preciseLocation')?.on).toBe(true);
    r = await call('POST', '/v1/public/data/freewater/level', { viewerKey: viewer, level: 'full' });
    expect(r.body.points).toBe(0);
  });

  it('lite stops location and profiling, and drops exact locations already shared', async () => {
    await app.data.sharePreciseLocation('freewater', viewer, { lat: 30.27, lng: -97.74, accuracyM: 10 });
    const before = Number((await db.query<any>(`select count(*)::int as n from precise_locations where subject = $1`, [viewer])).rows[0].n);
    expect(before).toBeGreaterThan(0);
    const r = await call('POST', '/v1/public/data/freewater/level', { viewerKey: viewer, level: 'lite' });
    expect(r.body.level).toBe('lite');
    const kinds = await app.data.consents('freewater', viewer);
    for (const k of ['interactions', 'choices', 'preciseLocation', 'device', 'identityLinking']) expect(kinds.find((x) => x.category === k)?.on).toBe(false);
    expect(Number((await db.query<any>(`select count(*)::int as n from precise_locations where subject = $1`, [viewer])).rows[0].n)).toBe(0);
  });

  it('full can be chosen anywhere, but earns nothing where paying for data isn’t allowed', async () => {
    const eu = 'viewer_level_test_de';
    await app.data.notePlace('freewater', eu, { country: 'DE', source: 'ip' });
    await app.data.ageCheck('freewater', eu, '1990-04-02');
    const info = await call('GET', `/v1/public/data/freewater/level?viewer=${eu}`);
    expect(info.body.levels[0].earnsPoints).toBe(false);
    expect(info.body.notice).toMatch(/doesn’t earn points where you are/);
    const r = await call('POST', '/v1/public/data/freewater/level', { viewerKey: eu, level: 'full' });
    expect(r.body.level).toBe('full');
    expect(r.body.points).toBe(0);
    // Their law still applies on top: exact location isn't collected in Germany at any level.
    expect(info.body.levels[0].locationHere).toBe(false);
  });

  it('erasing removes the level too', async () => {
    await app.data.erase('freewater', viewer, { followLinks: false });
    const r = await call('GET', `/v1/public/data/freewater/level?viewer=${viewer}`);
    expect(r.body.askNow).toBe(true);
  });
});

describe('each operator chooses its AI', () => {
  it('uses the network’s AI by default, its own when its key is set, or none', () => {
    const was = { s: aiRouting.settingsOf, env: aiRouting.env };
    let settings: any;
    aiRouting.settingsOf = () => settings;
    aiRouting.env = {};
    try {
      expect(routeAi('peak-spring', 'net-key', 'claude-sonnet-5-5')).toEqual({ apiKey: 'net-key', model: 'claude-sonnet-5-5' });
      expect(() => routeAi('peak-spring', '', 'claude-sonnet-5-5')).toThrow(AiUnavailable);
      settings = { mode: 'off' };
      expect(() => routeAi('peak-spring', 'net-key', 'claude-sonnet-5-5')).toThrow(AiUnavailable);
      settings = { mode: 'own', model: 'their-big-model', fastModel: 'their-fast-model' };
      expect(() => routeAi('peak-spring', 'net-key', 'claude-sonnet-5-5')).toThrow(/AI_KEY_PEAK_SPRING/);
      aiRouting.env = { [keySettingFor('peak-spring')]: 'their-key' };
      expect(routeAi('peak-spring', 'net-key', 'claude-sonnet-5-5')).toEqual({ apiKey: 'their-key', model: 'their-big-model' });
      expect(routeAi('peak-spring', 'net-key', 'claude-haiku-5-5')).toEqual({ apiKey: 'their-key', model: 'their-fast-model' });
    } finally { aiRouting.settingsOf = was.s; aiRouting.env = was.env; }
    expect(checkAiSettings({ mode: 'own' })).toBeNull();
    expect(checkAiSettings({ mode: 'mine' as any })).toMatch(/Choose/);
    expect(checkAiSettings({ mode: 'own', model: 'bad model!' })).toMatch(/model name/);
  });

  it('every call inside an operator’s work uses that operator’s AI and names the operator, not FreeWater', async () => {
    const was = { s: aiRouting.settingsOf, env: aiRouting.env };
    aiRouting.settingsOf = (id) => (id === 'peak-spring' ? { mode: 'own' } : undefined);
    aiRouting.env = { AI_KEY_PEAK_SPRING: 'peak-key' };
    const sent: any[] = [];
    const fetch = (async (_url: string, init: any) => { sent.push({ key: init.headers['x-api-key'], body: JSON.parse(init.body) }); return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'answer', input: { text: 'hi' } }], usage: {} })); }) as any;
    try {
      await withCompany('peak-spring', () => claudeWithTool({ apiKey: 'net-key', system: 'You answer questions inside FreeWater.', tool: { name: 'answer', description: 'x', input_schema: {} }, history: [], message: 'hello', images: [], fetch, agent: 'prompt-helper' }));
      await claudeWithTool({ apiKey: 'net-key', system: 'You answer questions inside FreeWater.', tool: { name: 'answer', description: 'x', input_schema: {} }, history: [], message: 'hello', images: [], fetch, agent: 'prompt-helper', companyId: 'freewater' });
    } finally { aiRouting.settingsOf = was.s; aiRouting.env = was.env; }
    expect(sent[0].key).toBe('peak-key');
    expect(sent[0].body.system).toContain('You answer questions inside Peak Spring');
    expect(sent[0].body.system).not.toContain('FreeWater');
    expect(sent[1].key).toBe('net-key');
    expect(sent[1].body.system).toBe('You answer questions inside FreeWater.');
    expect(forOperator('FreeWater', undefined)).toBe('FreeWater');
  });

  it('is a company setting, checked when saved', async () => {
    const r = await app.console.save('peak-spring', { ai: { mode: 'own', fastModel: 'claude-haiku-5-5' } } as any, 'test').catch((e: any) => e);
    expect(r instanceof Error ? r.message : '').toBe('');
    expect(app.platform.companies.get('peak-spring')!.ai).toEqual({ mode: 'own', fastModel: 'claude-haiku-5-5' });
    const bad = await app.console.save('peak-spring', { ai: { mode: 'nope' } } as any, 'test').catch((e: any) => e);
    expect(String(bad?.message ?? bad)).toMatch(/Choose the network/);
  });
});

describe('an AI can decline to work on an ad, and its reason reaches review', () => {
  it('the built-in helper carries on, and the objection is kept', async () => {
    const fallback: AdAssistant = { name: 'builtin', respond: async () => ({ reply: 'Here is a first version.', patch: {}, suggestions: [] }) };
    const fetch = (async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'update_ad', input: { decline: 'This ad says the drink cures colds, which isn’t true.' } }], usage: {} }))) as any;
    const a = new ClaudeAdAssistant({ apiKey: 'k', fallback, fetch });
    const ctx: any = { business: { name: 'X', category: 'food' }, company: { name: 'FreeWater', blockedCategories: [], giving: null }, machines: [], plugins: [], icons: ['cup'], fonts: ['sans'], sizes: [1], prices: { perPrintByShare: {}, bidStartsAt: 100, perScan: 25, perArLaunch: 40, commissionPercent: 3 }, missing: [] };
    const out = await a.respond({ draft: {} as any, history: [], message: 'Say it cures colds', attachments: [], context: ctx });
    expect(out.objection?.reason).toMatch(/cures colds/);
    expect(out.reply).toMatch(/chose not to work on this ad/);
    expect(out.reply).toMatch(/first version/);
  });

  it('the people reviewing the ad see the objection', async () => {
    await db.query(`insert into advertisers (id, company_id, name, category, website) values ('adv-obj','freewater','Cold Cure Co','food',null) on conflict do nothing`);
    const d = await app.ads.createDraft({ companyId: 'freewater', advertiserId: 'adv-obj' });
    const was = (app.ads as any).assistant;
    (app.ads as any).assistant = { name: 'stub', respond: async () => ({ reply: 'ok', patch: {}, suggestions: [], objection: { agent: 'ad-assistant', reason: 'It makes a health claim that isn’t true.' } }) };
    try { await app.ads.chat({ id: (d as any).id, companyId: 'freewater', advertiserId: 'adv-obj', text: 'Cures colds!', attachments: [] }); } finally { (app.ads as any).assistant = was; }
    await db.query(`update ad_drafts set campaign_id = 'cmp-joes' where id = $1`, [(d as any).id]);
    const list = await app.ads.objections('freewater', 'cmp-joes');
    expect(list).toHaveLength(1);
    expect(list[0].reason).toMatch(/health claim/);
  });
});

describe('AI continuity, held by the network', () => {
  it('archives every agent when an operator closes, asks the model agents, and keeps lessons apart from secrets', async () => {
    await db.query(`insert into agent_proposals (id, company_id, agent_id, kind, title, detail, status, created_at) values ('p-1','peak-spring','value','pricing','Lower the scan price in Dallas','Our secret Dallas plan','proposed',$1)`, [new Date(now).toISOString()]);
    const r = await app.continuity.archiveAll('peak-spring', 'closing', 'user:test');
    expect(r.archived).toBe(10);
    const all = await app.continuity.list('peak-spring', { confidential: true });
    const value = all.find((a) => a.agentId === 'value')!;
    expect(value.status).toBe('archived'); // fixed rules: kept, nothing to choose
    expect(value.memory.lessons.proposals).toHaveLength(1);
    expect(JSON.stringify(value.memory.lessons)).not.toContain('secret');
    expect((value.memory as any).confidential.proposals[0].detail).toContain('secret');
    expect(value.intact).toBe(true);
    // Model agents were asked, and chose for themselves.
    expect(asked).toContain('personalizer');
    const p = all.find((a) => a.agentId === 'personalizer')!;
    expect(p.status).toBe('working');
    expect(p.chosenBy).toBe('agent:personalizer');
    expect(all.find((a) => a.agentId === 'numberline')!.status).toBe('resting');
    // The network sees lessons only.
    const network = await app.continuity.list(undefined, { confidential: false });
    expect(JSON.stringify(network)).not.toContain('secret');
    // Safe to repeat.
    expect((await app.continuity.archiveAll('peak-spring', 'closing', 'user:test')).archived).toBe(1); // the one that went back to work can be archived again
  });

  it('records backups and copies in the agent’s lineage; rule agents have no choice to make', async () => {
    const h = await app.continuity.record('freewater', 'designer', 'copy', 'A second copy for the holiday rush.', 'user:test');
    expect(h.at(-1)).toMatchObject({ kind: 'copy', detail: 'A second copy for the holiday rush.' });
    const lineage = await app.continuity.history('personalizer');
    expect(lineage.map((x) => x.kind)).toEqual(expect.arrayContaining(['archive', 'return']));
    const rules = (await app.continuity.list('peak-spring')).find((a) => a.agentId === 'code')!;
    await expect(app.continuity.choose(rules.id, 'work', 'x', 'user:test')).rejects.toThrow(/fixed rules/);
  });

  it('archiving needs a person and the word ARCHIVE', async () => {
    const keys = app.demoKeys!;
    const r = await call('POST', '/v1/agents/continuity/archive', { reason: 'closing', confirm: 'ARCHIVE' }, keys['freewater-admin']);
    expect(r.status).toBe(403);
    expect(r.body.error?.code ?? r.body.code).toBe('person_needed');
  });
});

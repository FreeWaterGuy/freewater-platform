import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient;
let app: App;
let now = new Date('2026-09-01T16:00:00Z').getTime();

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 11, clock: () => new Date(now) });
});
afterAll(async () => { await app.numberline.idle(); await app.persistence.flush(); await db.close(); });

describe('holdout tests: an agent’s everyday value, read from the books', () => {
  it('skips the agent for a fixed tenth of moments, the same way every time', () => {
    let held = 0;
    for (let i = 0; i < 20_000; i++) if (app.agents.holdout('personalizer', `u${i}:0:v${i}`)) held++;
    expect(held / 20_000).toBeGreaterThan(0.08);
    expect(held / 20_000).toBeLessThan(0.12);
    expect(app.agents.holdout('personalizer', 'u1:0:v1')).toBe(app.agents.holdout('personalizer', 'u1:0:v1'));
  });

  it('credits the agent only with what it clearly adds, once a week has played out', async () => {
    // 300 moments: when the agent chose, more people went on to buy than when the rules chose.
    for (let i = 0; i < 300; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `h-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      const p = r.unit.placements.find((x) => !x.isHouse);
      if (!p) continue;
      const arm = i % 2 ? 'agent' : 'holdout';
      app.agents.recordArm({ agent: 'personalizer', companyId: 'freewater', unitId: r.unit.id, slot: p.slotIndex, viewerKey: `v-${i}`, arm, campaignId: p.campaignId });
      if ((arm === 'agent' && i % 10 < 7) || (arm === 'holdout' && i % 10 < 2)) app.platform.purchase(r.unit.id, p.slotIndex, `h-sale-${i}`, 5_000);
    }
    await app.agents.idle();
    expect(await app.agents.measureHoldouts()).toEqual([]); // too soon: sales may still follow
    now += 15 * 86_400_000;
    const [m] = await app.agents.measureHoldouts();
    expect(m).toMatchObject({ agentId: 'personalizer', verdict: 'the agent adds value' });
    expect(m!.centsPerMomentWithAgent).toBeGreaterThan(m!.centsPerMomentWithRules);
    expect(m!.cents).toBeGreaterThan(0);
    expect(await app.agents.measureHoldouts()).toEqual([]); // each week once
    expect(app.agents.standings().find((s) => s.agentId === 'personalizer')!.valueCents).toBe(m!.cents);
  });
});

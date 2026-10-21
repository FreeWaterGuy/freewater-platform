import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlClient } from '../src/db/client';
import { migrate, migrations } from '../src/db/migrations';
import { engines, freshDb } from './db-helpers';

// The database itself refuses rewriting the money journals and logs (migrations 052 and 053), allowing only the
// changes the platform really makes. Run on PGlite, and on a real Postgres when FW_TEST_PG_ADMIN_URL is set.

const at = '2026-10-01T12:00:00Z';
const refused = (p: Promise<unknown>, re: RegExp = /append-only|can.t|can only|permanent|sealed|voided|below zero|add to zero|violates/) => expect(p).rejects.toThrow(re);

describe.each(engines)('journals can’t be rewritten (%s)', (engine) => {
  let db: SqlClient;
  const q = (sql: string, args: unknown[] = []) => db.query<any>(sql, args);
  const tx = (sqls: [string, unknown[]?][]) => db.transaction(async (t) => { for (const [s, a] of sqls) await t.query(s, a ?? []); });
  const entry = async (id: string, lines: [string, number][], company = 'co') => {
    await tx([[`insert into wallet_tx (id, company_id, asset, kind, ref, memo, day, at, source) values ($1,$2,'points:co','earn:scan',$3,'{}','2026-10-01',$4,'src')`, [id, company, `ref:${id}`, at]],
      ...lines.map(([a, n]) => [`insert into wallet_lines (tx_id, account, amount) values ($1,$2,$3)`, [id, a, n]] as [string, unknown[]])]);
  };

  beforeAll(async () => {
    db = await freshDb(engine);
    await migrate(db);
    await q(`insert into companies (id, config) values ('co', '{}'), ('live', '{"launch":{"stage":"points"}}')`);
  });
  afterAll(async () => { await db.close(); });

  it('wallet entries: never edited or deleted; marked undone once; the fingerprint only cleared', async () => {
    await entry('w1', [['supply', -5], ['holder:a', 5]]);
    await refused(q(`update wallet_tx set kind = 'earn:game' where id = 'w1'`));
    await refused(q(`update wallet_tx set memo = '{"x":1}' where id = 'w1'`));
    await refused(q(`update wallet_tx set source = 'other' where id = 'w1'`));
    await q(`update wallet_tx set source = null where id = 'w1'`);
    await q(`update wallet_tx set reversed_by = 'w2' where id = 'w1'`);
    await refused(q(`update wallet_tx set reversed_by = 'w3' where id = 'w1'`));
    await refused(q(`update wallet_tx set reversed_by = null where id = 'w1'`));
    await refused(q(`delete from wallet_tx where id = 'w1'`));
    await refused(q(`update wallet_lines set amount = 50 where tx_id = 'w1'`));
    await refused(q(`delete from wallet_lines where tx_id = 'w1'`));
    await refused(q(`truncate wallet_lines`), /append-only/);
    expect((await q(`select sum(amount)::int as s from wallet_lines where tx_id = 'w1'`)).rows[0].s).toBe(0);
  });

  it('every wallet entry adds to zero, and lines are never zero', async () => {
    await refused(entry('bad1', [['supply', -5], ['holder:a', 4]]), /add to zero/);
    expect((await q(`select 1 from wallet_tx where id = 'bad1'`)).rows).toHaveLength(0);
    await refused(entry('bad2', [['supply', 0], ['holder:a', 0]]), /violates|zero/);
  });

  it('no person’s wallet or brand’s reserve goes below zero; the supply and outside money may', async () => {
    const add = (account: string, n: number) => q(`insert into wallet_balances (company_id, asset, account, balance) values ('co','credit:co',$1,$2) on conflict (company_id, asset, account) do update set balance = wallet_balances.balance + excluded.balance`, [account, n]);
    await add('supply', -100);
    await add('outside:brand', -100);
    await add('reserve:brand', 100);
    await add('reserve:brand', -100); // down to zero is fine
    await refused(add('reserve:brand', -1), /below zero/);
    await add('holder:b', 10);
    await refused(add('holder:b', -11), /below zero/);
    await refused(add('holder:new', -1), /below zero/);
    expect(Number((await q(`select balance from wallet_balances where account = 'holder:b'`)).rows[0].balance)).toBe(10);
  });

  it('the test-stage reset may wipe a company’s journal, only inside its own transaction, and never once live', async () => {
    await entry('r1', [['supply', -1], ['holder:r', 1]]);
    await entry('r2', [['supply', -1], ['holder:r', 1]], 'live');
    await refused(q(`delete from wallet_lines where tx_id = 'r1'`));
    const wipe = (company: string, id: string) => db.transaction(async (t) => {
      await t.query(`select set_config('fw.test_reset', $1, true)`, [company]);
      await t.query(`delete from wallet_lines where tx_id = $1`, [id]);
      await t.query(`delete from wallet_tx where id = $1`, [id]);
    });
    await refused(wipe('co', 'r2')); // another company's entry
    await refused(wipe('live', 'r2')); // a live company
    await wipe('co', 'r1');
    expect((await q(`select 1 from wallet_tx where id = 'r1'`)).rows).toHaveLength(0);
    await refused(q(`delete from wallet_tx where id = 'w1'`)); // the setting was only for that transaction
  });

  it('seals only gain places they were published to; checks are append-only', async () => {
    await q(`insert into chain_seals (company_id, hour, root, entries_root, prev_root, entries, refs, at) values ('co',$1,'r','e','p',1,'{"github":"x"}',$1)`, [at]);
    await q(`update chain_seals set refs = '{"github":"x","chain":"y"}'`);
    await refused(q(`update chain_seals set refs = '{"chain":"y"}'`));
    await refused(q(`update chain_seals set root = 'forged'`));
    await refused(q(`delete from chain_seals`));
    await q(`insert into chain_checks (company_id, at, books, chain, ok) values ('co',$1,1,1,true)`, [at]);
    await refused(q(`update chain_checks set ok = false`));
  });

  it('chain actions: fixed proposal, approvals only grow while proposed, status only forward, ref kept, finished ones frozen', async () => {
    const ins = (id: string, kind: string, status: string, params = '{"to":"viewer-1","amount":5}') => q(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, rules) values ($1,'co',$2,$3,'user:a','[]',2,$4,$5,'{"delayHours":48}')`, [id, kind, params, status, at]);
    await ins('ca1', 'mint', 'proposed');
    await refused(q(`update chain_actions set params = '{"to":"me","amount":5000}' where id = 'ca1'`));
    await refused(q(`update chain_actions set rules = '{"delayHours":0}' where id = 'ca1'`));
    await refused(q(`update chain_actions set needed = 0 where id = 'ca1'`));
    await q(`update chain_actions set approvals = '[{"by":"user:b"}]' where id = 'ca1'`);
    await refused(q(`update chain_actions set approvals = '[{"by":"user:c"}]' where id = 'ca1'`)); // replaced, not added to
    await q(`update chain_actions set approvals = '[{"by":"user:b"},{"by":"user:c"}]', status = 'approved', not_before = $1 where id = 'ca1'`, [at]);
    await refused(q(`update chain_actions set approvals = '[{"by":"user:b"},{"by":"user:c"},{"by":"user:d"}]' where id = 'ca1'`));
    await refused(q(`update chain_actions set not_before = '2020-01-01' where id = 'ca1'`)); // the wait can't be cut short
    await refused(q(`update chain_actions set status = 'done' where id = 'ca1'`)); // approved can't skip running
    await q(`update chain_actions set status = 'running', running_at = $1 where id = 'ca1'`, [at]);
    await q(`update chain_actions set params = '{"to":"viewer-1","amount":5,"plan":{"total":5}}' where id = 'ca1'`); // the plan is added
    await refused(q(`update chain_actions set params = '{"to":"viewer-1","amount":6,"plan":{"total":6}}' where id = 'ca1'`));
    await q(`update chain_actions set ref = 'sig1' where id = 'ca1'`);
    await refused(q(`update chain_actions set ref = 'sig2' where id = 'ca1'`));
    await q(`update chain_actions set status = 'done', ran_by = 'user:a', ran_at = $1 where id = 'ca1'`, [at]);
    await refused(q(`update chain_actions set status = 'approved' where id = 'ca1'`));
    await refused(q(`update chain_actions set ran_by = 'someone else' where id = 'ca1'`));
    await q(`update chain_actions set params = jsonb_set(params, '{to}', '"erased"') where id = 'ca1'`); // erasing the person
    await refused(q(`delete from chain_actions where id = 'ca1'`));
    // The test reset deletes test actions, but never a pause.
    await ins('ca2', 'pause', 'done', '{}');
    await ins('ca3', 'mint', 'cancelled');
    const reset = (id: string) => db.transaction(async (t) => { await t.query(`select set_config('fw.test_reset', 'co', true)`); await t.query(`delete from chain_actions where id = $1`, [id]); });
    await refused(reset('ca2'));
    await reset('ca3');
  });

  it('chain actions: one conversion under way, and a signature recorded for one mint only', async () => {
    const ins = (id: string, kind: string, status: string, ref: string | null = null) => q(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, rules, ref) values ($1,'co',$2,'{}','user:a','[]',2,$3,$4,'{}',$5)`, [id, kind, status, at, ref]);
    await ins('cv1', 'convert', 'proposed');
    await refused(ins('cv2', 'convert', 'proposed'), /duplicate|unique/);
    await ins('m1', 'mint', 'done', 'sigX');
    await refused(ins('m2', 'mint', 'confirming', 'sigX'), /duplicate|unique/);
    await refused(ins('m3', 'mint', 'nonsense'), /violates/);
  });

  it('charity transfers: amount fixed; sending → sent or failed once; sent → confirmed once; never deleted', async () => {
    await q(`insert into charities (id, company_id, name) values ('ch1','co','Well Aware')`);
    const ins = (id: string, number: string, status: string, day: string, cents = 2500) => q(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, created_at, day) values ($1,'co',$2,'ch1',$3,$4,10,$5,'test',$4,$6)`, [id, number, cents, at, status, day]);
    await refused(ins('t0', 'T-1000', 'sending', '2026-09-30', 0), /violates/);
    await ins('t1', 'T-1001', 'sending', '2026-10-01');
    await refused(ins('t2', 'T-1002', 'sending', '2026-10-02'), /duplicate|unique/); // one waiting for the bank at a time
    await refused(q(`update charity_transfers set amount_cents = 1 where id = 't1'`));
    await refused(q(`update charity_transfers set status = 'confirmed' where id = 't1'`));
    await q(`update charity_transfers set status = 'sent', provider_ref = 'bank-1', confirm_token_hash = 'h' where id = 't1' and status = 'sending'`);
    await refused(q(`update charity_transfers set provider_ref = 'bank-2' where id = 't1'`));
    await refused(q(`update charity_transfers set status = 'failed' where id = 't1'`));
    await q(`update charity_transfers set status = 'confirmed', confirmed_at = $1 where id = 't1'`, [at]);
    await refused(q(`update charity_transfers set confirmed_at = null where id = 't1'`));
    await refused(q(`delete from charity_transfers where id = 't1'`));
  });

  it('gift-card purchases: what was bought is fixed, a sent one stays sent', async () => {
    await q(`insert into wallet_giftcards (company_id, ref, subject, entry, product, cents, status, at) values ('co','gc1','user:u','w1','amazon',500,'ordering',$1)`, [at]);
    await refused(q(`update wallet_giftcards set cents = 50000 where ref = 'gc1'`));
    await q(`update wallet_giftcards set status = 'unknown' where ref = 'gc1'`);
    await q(`update wallet_giftcards set status = 'sent', provider_ref = 'p' where ref = 'gc1'`);
    await refused(q(`update wallet_giftcards set status = 'refused' where ref = 'gc1'`));
    await refused(q(`delete from wallet_giftcards where ref = 'gc1'`));
  });

  it('security log, archives, batches, closed months, settings history, resets, autonomy and lineage', async () => {
    await q(`insert into security_events (id, company_id, kind, actor, ip, detail, at) values ('se1','co','sign_in','jo@x.io','1.2.3.4','{}',$1)`, [at]);
    await q(`update security_events set actor = 'j***@x.io', ip = null where id = 'se1'`);
    await refused(q(`update security_events set kind = 'nothing' where id = 'se1'`));
    await refused(q(`delete from security_events where id = 'se1'`));

    await q(`insert into agent_archives (id, company_id, agent_id, reason, memory, fund_cents, status, archived_by, at, sealed) values ('ar1','co','a','closing','{}',100,'archived','user:a',$1,'seal')`, [at]);
    await q(`update agent_archives set status = 'resting', choice = 'rest', decided_at = $1 where id = 'ar1'`, [at]);
    await refused(q(`update agent_archives set fund_cents = 100000 where id = 'ar1'`));
    await refused(q(`delete from agent_archives where id = 'ar1'`));

    await q(`insert into distributions (id, company_id, day, bottles, data, recorded_by, at) values ('d1','co','2026-10-01',50,'{}','user:a',$1)`, [at]);
    await refused(q(`update distributions set bottles = 5000 where id = 'd1'`));
    await q(`update distributions set voided_at = $1, voided_by = 'user:a', void_reason = 'wrong' where id = 'd1' and voided_at is null`, [at]);
    await refused(q(`update distributions set voided_at = null where id = 'd1'`));
    await refused(q(`delete from distributions where id = 'd1'`));

    await q(`insert into profit_periods (company_id, period, data, closed_at) values ('co','2026-09','{}',$1)`, [at]);
    await q(`insert into company_config_versions (company_id, version, config, summary) values ('co',1,'{}','[]')`);
    await q(`insert into launch_resets (company_id, at, by, counts) values ('co',$1,'user:a','{}')`, [at]);
    await q(`insert into autonomy_changes (id, company_id, area, from_level, to_level, by, reason, at) values ('au1','co','spending',1,2,'user:a','x',$1)`, [at]);
    await q(`insert into agent_lineage (id, agent_id, company_id, kind, detail, by, at) values ('li1','a','co','backup','x','user:a',$1)`, [at]);
    for (const t of ['profit_periods', 'company_config_versions', 'launch_resets', 'autonomy_changes', 'agent_lineage']) {
      await refused(q(`update ${t} set company_id = company_id`), /append-only/);
      await refused(q(`delete from ${t}`), /append-only/);
      await refused(q(`truncate ${t}`), /append-only/);
    }
    await refused(q(`truncate ledger_entries`), /append-only/);
  });
});

describe.each(engines)('the new rules go in over data already stored (%s)', (engine) => {
  let db: SqlClient;
  afterAll(async () => { await db.close(); });

  it('a database at migration 050 with rows breaking the new rules still migrates; the rules hold for new rows', async () => {
    db = await freshDb(engine);
    const before = migrations.filter((m) => m.id < '052');
    await migrate(db, before);
    const q = (sql: string, args: unknown[] = []) => db.query<any>(sql, args);
    await q(`insert into companies (id, config) values ('co', '{}')`);
    await q(`insert into charities (id, company_id, name) values ('ch1','co','Well Aware')`);
    // Rows earlier code could have left: a zero transfer, two waiting for the bank, an overdrawn wallet, a bad status.
    for (const [id, n, cents, day] of [['t1', 'T-1', 0, '2026-09-01'], ['t2', 'T-2', 100, '2026-09-02']] as const) {
      await q(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, created_at, day) values ($1,'co',$2,'ch1',$3,$4,1,'sending','test',$4,$5)`, [id, n, cents, at, day]);
    }
    await q(`insert into wallet_balances (company_id, asset, account, balance) values ('co','points:co','holder:x',-3)`);
    await q(`insert into wallet_giftcards (company_id, ref, subject, entry, product, cents, status, at) values ('co','g','s','e','p',5,'weird',$1)`, [at]);
    await q(`insert into wallet_tx (id, company_id, asset, kind, ref, memo, day, at) values ('old','co','points:co','earn:scan','r','{}','2026-09-01',$1)`, [at]);
    await q(`insert into wallet_lines (tx_id, account, amount) values ('old','supply',-1),('old','holder:x',1)`);

    expect(await migrate(db)).toEqual(migrations.filter((m) => m.id >= '052').map((m) => m.id));
    // Old rows stay as they were; the checks they break stay unvalidated, the others are validated.
    const valid = Object.fromEntries((await q(`select conname, convalidated from pg_constraint where conname in ('charity_transfers_amount_positive', 'wallet_giftcards_status_check', 'wallet_lines_not_zero')`)).rows.map((r) => [r.conname, r.convalidated]));
    expect(valid).toEqual({ charity_transfers_amount_positive: false, wallet_giftcards_status_check: false, wallet_lines_not_zero: true });
    expect((await q(`select 1 from pg_indexes where indexname = 'charity_transfers_one_sending'`)).rows).toHaveLength(0);
    // New rows are held to them, and the old journal can't be edited now.
    await refused(q(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, created_at, day) values ('t3','co','T-3','ch1',0,$1,1,'failed','test',$1,'2026-09-03')`, [at]), /violates/);
    await refused(q(`update wallet_balances set balance = balance - 1 where account = 'holder:x'`), /below zero/);
    await q(`update wallet_balances set balance = balance + 1 where account = 'holder:x'`); // a correction toward zero is fine
    await refused(q(`update wallet_lines set amount = 5 where tx_id = 'old'`));
    // Running again does nothing.
    expect(await migrate(db)).toEqual([]);
  });
});

describe.each(engines)('paid-up-front and route money can’t be rewritten (069, %s)', (engine) => {
  let db: SqlClient;
  const q = (sql: string, args: unknown[] = []) => db.query<any>(sql, args);
  const no = (p: Promise<unknown>) => expect(p).rejects.toThrow(/^(ad_orders|ad_prepaid|ad_refunds|ad_extra_uses|route_spots) /);
  beforeAll(async () => {
    db = await freshDb(engine);
    await migrate(db);
    await q(`insert into ad_orders (id, company_id, advertiser_id, campaign_id, kind, bottles, share, product_id, price_cents, total_cents, status) values ('o1','co','adv','cmp1','bottles',10,4,'p',20,200,'paying')`);
    await q(`insert into ad_prepaid (campaign_id, company_id, advertiser_id, share, product_id, price_cents, paid) values ('cmp1','co','adv',4,'p',20,10)`);
    await q(`insert into ad_refunds (id, company_id, campaign_id, advertiser_id, bottles, bottles_cents, extras_cents, total_cents, status, reason, stopped_by) values ('r1','co','cmp1','adv',4,80,0,80,'refunding','stopped','user:o')`);
    await q(`insert into ad_extra_uses (id, company_id, campaign_id, feature, status, charged_cents, at) values ('x1','co','cmp1','aiVideoClip','claimed',300,$1)`, [at]);
    for (const id of ['s1', 's2', 's3']) await q(`insert into route_spots (id, company_id, campaign_id, advertiser_id, order_id, house_id, week, bottle, share, units, price_cents, status) values ($1,'co','cmp1','adv','o1','h1','2026-11-09',$2,4,30,20,$3)`, [id, Number(id.slice(1)), 'open']);
  });
  afterAll(async () => { await db.close(); });

  it('an order: only paying moves to paid or declined, then it is final; never deleted', async () => {
    await no(q(`update ad_orders set total_cents = 1 where id = 'o1'`));
    await q(`update ad_orders set credit_cents = 50 where id = 'o1'`); // the credit used, in the paying step
    await q(`update ad_orders set status = 'paid', payment_id = 'pay1', paid_at = now() where id = 'o1'`);
    await no(q(`update ad_orders set status = 'declined' where id = 'o1'`));
    await no(q(`update ad_orders set credit_cents = 0 where id = 'o1'`));
    await no(q(`delete from ad_orders where id = 'o1'`));
  });

  it('paid bottles: what was paid never changes; paid back only grows; stopped stays stopped', async () => {
    await q(`update ad_prepaid set held = held + 1 where campaign_id = 'cmp1'`);
    await q(`update ad_prepaid set held = held - 1, printed = printed + 1 where campaign_id = 'cmp1'`);
    await no(q(`update ad_prepaid set paid = 20 where campaign_id = 'cmp1'`));
    await no(q(`update ad_prepaid set price_cents = 1 where campaign_id = 'cmp1'`));
    await q(`update ad_prepaid set refunded = 4, stopped_at = now() where campaign_id = 'cmp1'`);
    await no(q(`update ad_prepaid set refunded = 0 where campaign_id = 'cmp1'`));
    await no(q(`update ad_prepaid set stopped_at = null where campaign_id = 'cmp1'`));
    await no(q(`delete from ad_prepaid where campaign_id = 'cmp1'`));
  });

  it('a refund: amounts fixed; failed may be retried; refunded is done', async () => {
    await no(q(`update ad_refunds set total_cents = 8000 where id = 'r1'`));
    await q(`update ad_refunds set status = 'failed', failure = 'declined' where id = 'r1'`);
    await q(`update ad_refunds set status = 'refunded', failure = null, done_at = now() where id = 'r1'`);
    await no(q(`update ad_refunds set status = 'refunding' where id = 'r1'`));
    await no(q(`delete from ad_refunds where id = 'r1'`));
  });

  it('a paid extra: its charge fixed; settled stays settled', async () => {
    await no(q(`update ad_extra_uses set charged_cents = 0 where id = 'x1'`));
    await q(`update ad_extra_uses set status = 'used', cost_cents = 120 where id = 'x1'`);
    await no(q(`update ad_extra_uses set status = 'returned' where id = 'x1'`));
    await no(q(`delete from ad_extra_uses where id = 'x1'`));
  });

  it('a route piece: what, where and the price never change; its status only moves forward', async () => {
    await no(q(`update route_spots set price_cents = 0 where id = 's1'`));
    await no(q(`update route_spots set house_id = 'h2' where id = 's1'`));
    await q(`update route_spots set status = 'held' where id = 's1'`);
    await q(`update route_spots set status = 'open' where id = 's1'`); // a print that failed lets it go
    await q(`update route_spots set status = 'held' where id = 's1'`);
    await q(`update route_spots set status = 'placed', unit_id = 'u1', pack_id = 'pk1' where id = 's1'`);
    await q(`update route_spots set unit_id = 'u2' where id = 's1'`); // moved to its reprint
    await no(q(`update route_spots set status = 'open' where id = 's1'`));
    await q(`update route_spots set status = 'refunding', settlement_id = 'st1' where id = 's1'`);
    await q(`update route_spots set status = 'refunded' where id = 's1'`);
    await q(`update route_spots set status = 'cancelled' where id = 's2'`);
    await no(q(`update route_spots set status = 'open' where id = 's2'`));
    await q(`update route_spots set status = 'credited' where id = 's3'`);
    await no(q(`update route_spots set status = 'refunding' where id = 's3'`));
    await no(q(`delete from route_spots where id = 's3'`));
  });
});

import { randomBytes } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { DataService } from '../data/service';
import type { GamesService } from '../games/service';
import type { WalletService } from '../wallet/service';
import type { ChainService } from '../chain/service';

// Testing before going live. In the test stage a person on the team can let bots play (and scan, and send feedback)
// to see everything work at scale, and then wipe every test record with one reset. Bots are always marked as bots
// (their phone codes start with "bot_"), and nothing from the test stage can reach the live stages: going live is its
// own approved step, and from then on resetting is gone for good.

export class LaunchError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export class LaunchService {
  constructor(private db: SqlClient, private platform: Platform, private data: DataService, private games: GamesService, private wallet: WalletService, private chain: ChainService,
    private clock: () => Date = () => new Date(), private random: () => number = Math.random) {}

  private testOnly(companyId: string) {
    if (this.chain.stage(companyId) !== 'test') throw new LaunchError('live', 'This only works before going live.', 409);
  }

  /** Wipe everything the test stage made: wallets, game answers, offer claims, seals, the test chain, and every bot. */
  async reset(companyId: string, person: string) {
    this.testOnly(companyId);
    const counts: Record<string, number> = {};
    const run = async (name: string, sql: string, args: unknown[] = [companyId]) => { const r: any = await this.db.query(sql, args); counts[name] = (counts[name] ?? 0) + Number(r.rowCount ?? 0); };
    await this.db.transaction(async (tx) => {
      const q = async (name: string, sql: string, args: unknown[] = [companyId]) => { const r: any = await tx.query(sql, args); counts[name] = (counts[name] ?? 0) + Number(r.rowCount ?? 0); };
      await q('offer claims', `delete from offer_claims where company_id = $1`);
      // Money a brand really sent into a reserve stays (and anything correcting it); everything people earned, got or
      // spent while testing goes. Balances are then rebuilt from what's left, so the books still add up.
      const keep = `(kind = 'fund' or (kind = 'correction' and memo->>'corrects' in (select id from wallet_tx where company_id = $1 and kind = 'fund')))`;
      await q('wallet lines', `delete from wallet_lines where tx_id in (select id from wallet_tx where company_id = $1 and not ${keep})`);
      await q('wallet entries', `delete from wallet_tx where company_id = $1 and not ${keep}`);
      await tx.query(`delete from wallet_balances where company_id = $1`, [companyId]);
      await tx.query(`insert into wallet_balances (company_id, asset, account, balance) select t.company_id, t.asset, l.account, sum(l.amount) from wallet_lines l join wallet_tx t on t.id = l.tx_id where t.company_id = $1 group by t.company_id, t.asset, l.account`, [companyId]);
      await q('wallets', `delete from wallet_holders where company_id = $1`);
      await q('game screens', `delete from game_rounds where company_id = $1`);
      await q('feedback and questions', `delete from game_notes where company_id = $1`);
      await q('players', `delete from game_players where company_id = $1`);
      await q('seals', `delete from chain_seals where company_id = $1`);
      await q('chain checks', `delete from chain_checks where company_id = $1`);
      // Pausing, unpausing and switching the chain on stay (a reset must never unpause anything), as does going live.
      await q('chain actions', `delete from chain_actions where company_id = $1 and kind not in ('go_live_points','pause','unpause','switch_on')`);
      await q('picks that came true', `delete from game_launches where company_id = $1`);
      await q('test chain', `delete from test_chain where company_id = $1`);
    });
    // Everything kept about the bots themselves.
    for (const [name, table, col] of [['bot consents', 'data_consents', 'subject'], ['bot places', 'person_places', 'subject'], ['bot details', 'person_details', 'subject'], ['bot locations', 'precise_locations', 'subject'], ['bot interactions', 'interactions', 'viewer_key'], ['bot choices', 'choices', 'person'], ['bot activity', 'activity', 'actor_id']] as const) {
      await run(name, `delete from ${table} where company_id = $1 and ${col} like 'bot\\_%'`).catch(() => {});
    }
    await this.chain.resetBaseline(companyId);
    await this.db.query(`insert into launch_resets (company_id, at, by, counts) values ($1,$2,$3,$4)`, [companyId, this.clock().toISOString(), person, JSON.stringify(counts)]);
    return { reset: true, counts };
  }

  /**
   * Bots play like people would, each with its own tastes: most like free and negatively priced things, some are
   * loyal to a few brands, a few are careless. They take a few seconds per screen, pass most quick checks, scan
   * bottles and sometimes write feedback. Everything they do is marked as theirs and wiped by a reset.
   */
  async runBots(companyId: string, o: { bots: number; rounds: number }) {
    this.testOnly(companyId);
    const bots = Math.max(1, Math.min(200, Math.floor(o.bots)));
    const rounds = Math.max(1, Math.min(60, Math.floor(o.rounds)));
    const r = this.random;
    let answered = 0, points = 0, scans = 0, notes = 0;
    const units = [...this.platform.units.values()].filter((u) => u.companyId === companyId && u.kind !== 'custom').slice(-500);
    for (let b = 0; b < bots; b++) {
      if (this.chain.stage(companyId) !== 'test') break; // going live stops the bots at once
      const key = `bot_${randomBytes(9).toString('base64url')}`;
      const taste = { free: 0.5 + r() * 0.4, brands: new Set<string>(), careless: r() < 0.08 };
      await this.data.notePlace(companyId, key, { country: 'US', state: ['TX', 'CA', 'NY', 'FL', 'IL'][Math.floor(r() * 5)]!, source: 'ip' });
      await this.data.ageCheck(companyId, key, `${1960 + Math.floor(r() * 45)}-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`);
      await this.games.join(companyId, key);
      for (let i = 0; i < rounds; i++) {
        const screen: any = await this.games.next(companyId, key).catch(() => null);
        if (!screen) break;
        // A few seconds to look at it (a careless bot rushes).
        const think = taste.careless ? 200 + r() * 300 : 1500 + r() * 4500;
        await this.db.query(`update game_rounds set served_at = served_at - ($2 || ' milliseconds')::interval where id = $1`, [screen.id, String(Math.round(think))]);
        const row = (await this.db.query<any>(`select items from game_rounds where id = $1`, [screen.id])).rows[0];
        const items: any[] = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
        let pick = items[Math.floor(r() * items.length)];
        if (screen.kind === 'check') pick = r() < (taste.careless ? 0.5 : 0.97) ? items.find((x) => x.correct) : pick;
        else if (screen.kind === 'choice') {
          const score = (x: any) => (x.frame?.kind === 'negative' ? 2 : x.frame?.kind?.startsWith('free') ? 1 : x.frame?.kind === 'discounted' ? 0.6 : 0) * taste.free + (taste.brands.has(x.brand) ? 1.5 : 0) + r();
          pick = items.reduce((best, x) => (score(x) > score(best) ? x : best), items[0]);
          if (pick.brand && r() < 0.3) taste.brands.add(pick.brand);
        }
        const t = screen.kind === 'tap' ? items[0].target : null;
        const tap = t ? { x: t.x + (r() - 0.5) * (taste.careless ? 0.4 : 0.08), y: t.y + (r() - 0.5) * (taste.careless ? 0.4 : 0.08), tMs: 350 + r() * 900 } : undefined;
        const a = await this.games.answer(companyId, key, screen.id, { pick: pick.key, changes: r() < 0.15 ? 1 : 0, responseMs: Math.round(think), ...(tap ? { tap } : {}), ...(screen.kind === 'ar' ? { spinMs: Math.round(r() * 8000) } : {}), ...(screen.kind === 'ad' && r() < 0.3 ? { why: 'The colors and the free offer caught my eye.' } : {}) }).catch(() => null);
        if (a) { answered++; points += a.points; }
      }
      if (units.length && r() < 0.7) {
        const u = units[Math.floor(r() * units.length)]!;
        // Never a real scan: that would bill the advertiser and count toward giving. Bots only earn the test points.
        const got = await this.wallet.earnScan(companyId, key, u.id, 0); points += got.points; scans++;
      }
      if (r() < 0.2) { const f = await this.games.feedback(companyId, key, { text: 'Bot feedback: I would love more free snacks at the gym machine.' }).catch(() => null); if (f) { notes++; points += f.points; } }
    }
    return { bots, answered, scans, feedback: notes, points };
  }

  async status(companyId: string) {
    const last = (await this.db.query<any>(`select at, by, counts from launch_resets where company_id = $1 order by at desc limit 1`, [companyId])).rows[0];
    const bots = Number((await this.db.query<any>(`select count(distinct person)::int as n from game_rounds where company_id = $1 and person like 'bot\\_%'`, [companyId])).rows[0].n);
    return { stage: this.chain.stage(companyId), canReset: this.chain.stage(companyId) === 'test', bots, lastReset: last ? { at: new Date(last.at).toISOString(), by: last.by } : null, withdrawals: !!this.platform.companies.get(companyId)?.launch?.withdrawals };
  }
}

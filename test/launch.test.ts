import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Keypair, Transaction } from '@solana/web3.js';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { SolanaChain, tokenAccount, TOKEN_2022_PROGRAM } from '../src/modules/chain/solana';
import { TestChain, type TokenChain } from '../src/modules/chain/plugs';

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-19T10:15:00Z').getTime();
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
// A chain that, like the real network, hands mints back for people to sign.
let signing = false;
const chainFor = (id: string): TokenChain => {
  const t = new TestChain(db, id, () => new Date(now));
  return { name: t.name, network: t.network, anchor: (r, l) => t.anchor(r, l), totalSupply: () => t.totalSupply(), balanceOf: (a) => t.balanceOf(a), setPaused: (p) => t.setPaused(p), paused: () => t.paused(),
    mint: async (to, amount, ref) => (signing ? { ref: '', prepared: 'base64-tx' } : t.mint(to, amount, ref)),
    confirmMint: async (sig, ref, amount) => { if (sig !== 'GoodSignature1111111111111111111111111111111111111111111111111') return false; await t.mint('custody', amount, ref); return true; } };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 101, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, anchorPublishers: [], chainFor });
  keys = app.demoKeys!;
  app.chain.isMember = async () => true;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('the test stage', () => {
  it('starts in test; bots play like people, marked as bots', async () => {
    expect(app.chain.stage('freewater')).toBe('test');
    for (let i = 0; i < 3; i++) await app.platform.order({ companyId: 'freewater', orderId: `l-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const r = await app.launch.runBots('freewater', { bots: 6, rounds: 12 });
    expect(r.answered).toBeGreaterThan(40);
    expect(r.points).toBeGreaterThan(0);
    const people = (await db.query<any>(`select distinct person from game_rounds`)).rows.map((x) => x.person as string);
    expect(people.every((p) => p.startsWith('bot_'))).toBe(true);
    const report = await app.games.report('freewater');
    expect(report.kept).toBeGreaterThan(20);
  });

  it('bots never bill advertisers, and a reset keeps money brands really sent', async () => {
    const before = app.platform.ledger.entries.length;
    await app.launch.runBots('freewater', { bots: 2, rounds: 2 });
    expect(app.platform.ledger.entries.length).toBe(before);
    await app.wallet.fundReserve('freewater', 'brand-real', 5_000, 'test', 'real-pay-1');
  });

  it('a reset wipes every test record, and a person must do it', async () => {
    expect((await call('POST', '/v1/launch/reset', { confirm: 'RESET' }, keys['freewater-admin'])).body.error.code).toBe('person_needed');
    const r = await app.launch.reset('freewater', 'user:josh');
    expect(r.counts['wallet entries']).toBeGreaterThan(0);
    for (const t of ['game_rounds', 'wallet_holders']) expect(Number((await db.query<any>(`select count(*)::int as n from ${t}`)).rows[0].n)).toBe(0);
    expect(Number((await db.query<any>(`select count(*)::int as n from person_details where subject like 'bot\\_%'`)).rows[0].n)).toBe(0);
    expect((await app.launch.status('freewater')).lastReset?.by).toBe('user:josh');
    expect(Number((await db.query<any>(`select balance from wallet_balances where account = 'reserve:brand-real'`)).rows[0].balance)).toBe(5000);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });

  it('the stage can’t be changed from settings', async () => {
    const { chainProblem } = await import('../src/modules/console/settings');
    expect(chainProblem({} as any, { launch: { stage: 'points' } } as any)).toMatch(/its own step/);
  });
});

describe('going live', () => {
  it('with points: one owner, then a day’s wait; after that, no more resets or bots', async () => {
    const a = await app.chain.propose('freewater', 'go_live_points', {}, 'user:josh');
    expect(a.status).toBe('approved');
    await expect(app.chain.run('freewater', a.id, 'user:josh')).rejects.toMatchObject({ code: 'waiting' });
    now += 25 * 3600_000;
    await app.chain.run('freewater', a.id, 'user:josh');
    expect(app.chain.stage('freewater')).toBe('points');
    await expect(app.launch.reset('freewater', 'user:josh')).rejects.toMatchObject({ code: 'live' });
    await expect(app.launch.runBots('freewater', { bots: 1, rounds: 1 })).rejects.toMatchObject({ code: 'live' });
    await expect(app.chain.propose('freewater', 'go_live_points', {}, 'user:josh')).rejects.toMatchObject({ code: 'wrong_stage' });
  });

  it('with the token: two more people approve, then the wait; then points turn into tokens held in custody', async () => {
    for (let i = 0; i < 3; i++) await app.wallet.earn('freewater', `viewer-launch-${i}`, 'scan', `lt:${i}`);
    await expect(app.chain.propose('freewater', 'convert', { tokensPerPoint: 1_000_000 }, 'user:josh')).rejects.toMatchObject({ code: 'wrong_stage' });
    const t = await app.chain.propose('freewater', 'go_live_token', {}, 'user:josh');
    await app.chain.approve('freewater', t.id, 'user:amy'); await app.chain.approve('freewater', t.id, 'user:raj');
    now += 49 * 3600_000;
    await app.chain.run('freewater', t.id, 'user:josh');
    expect(app.chain.stage('freewater')).toBe('token');
    expect(app.chain.settings('freewater').enabled).toBe(true);
    const c = await app.chain.propose('freewater', 'convert', { tokensPerPoint: 1_000_000 }, 'user:josh');
    await app.chain.approve('freewater', c.id, 'user:amy'); await app.chain.approve('freewater', c.id, 'user:raj');
    now += 49 * 3600_000;
    await app.chain.run('freewater', c.id, 'user:josh');
    const w = await app.wallet.wallet('freewater', 'viewer-launch-1');
    expect(w.points.balance).toBe(0);
    expect(w.token.balance).toBe(10 * 1_000_000);
    expect(w.token.live).toBe(true);
    expect((await app.chain.reconcile('freewater')).ok).toBe(true);
  });

  it('on the real network a mint waits for people to sign it in Squads, then is checked on the chain', async () => {
    signing = true;
    const m = await app.chain.propose('freewater', 'mint', { to: 'viewer-launch-0', amount: 5 }, 'user:josh');
    await app.chain.approve('freewater', m.id, 'user:amy'); await app.chain.approve('freewater', m.id, 'user:raj');
    now += 49 * 3600_000;
    const r = await app.chain.run('freewater', m.id, 'user:josh');
    expect(r.status).toBe('signing');
    expect((r as any).toSign).toBe('base64-tx');
    await expect(app.chain.confirmSigned('freewater', m.id, 'BadSignature11111111111111111111111111111111111111111111111111', 'user:josh')).rejects.toMatchObject({ code: 'not_found_on_chain' });
    expect((await app.chain.confirmSigned('freewater', m.id, 'GoodSignature1111111111111111111111111111111111111111111111111', 'user:josh')).status).toBe('done');
    expect((await app.wallet.wallet('freewater', 'viewer-launch-0')).token.balance).toBe(10 * 1_000_000 + 5);
    expect((await app.chain.reconcile('freewater')).ok).toBe(true);
    signing = false;
  });

  it('withdrawals stay off until approved', async () => {
    expect(app.platform.companies.get('freewater')!.launch?.withdrawals).toBeFalsy();
  });
});

describe('the Solana connection', () => {
  const mint = Keypair.generate().publicKey.toBase58();
  it('on the test network, mints into custody with the test key and records it in a memo', async () => {
    const sent: Transaction[] = [];
    const payer = Keypair.generate(), auth = Keypair.generate();
    const s = new SolanaChain({ network: 'devnet', rpcUrl: 'http://x', mint, payer, testMintAuthority: auth, connection: {} as any, send: async (tx) => { sent.push(tx); return 'sig1'; } });
    expect((await s.mint('x', 42, 'ca_1')).ref).toBe('sig1');
    const ixs = sent[0]!.instructions;
    expect(ixs.length).toBe(3);
    expect(ixs[1]!.programId.equals(TOKEN_2022_PROGRAM)).toBe(true);
    expect(ixs[1]!.data[0]).toBe(7); // MintTo
    expect(ixs[1]!.data.readBigUInt64LE(1)).toBe(42n);
    expect(ixs[1]!.keys[1]!.pubkey.equals(tokenAccount(payer.publicKey, new (await import('@solana/web3.js')).PublicKey(mint)))).toBe(true);
    expect(Buffer.from(ixs[2]!.data).toString()).toBe('fw-mint|ca_1');
  });
  it('on the real network, never mints by itself: it hands back a transaction for Squads', async () => {
    const vault = Keypair.generate().publicKey.toBase58();
    expect(() => new SolanaChain({ network: 'mainnet-beta', rpcUrl: 'http://x', mint, payer: Keypair.generate(), testMintAuthority: Keypair.generate(), connection: {} as any })).toThrow(/refused/);
    const s = new SolanaChain({ network: 'mainnet-beta', rpcUrl: 'http://x', mint, payer: Keypair.generate(), custody: vault, connection: { getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }) } as any });
    const r = await s.mint('x', 7, 'ca_2');
    expect(r.ref).toBe('');
    expect(r.prepared).toBeTruthy();
  });
  it('checks a signed mint on the chain: our memo and the exact amount', async () => {
    const { PublicKey } = await import('@solana/web3.js');
    const vault = Keypair.generate().publicKey;
    const custodyAccount = tokenAccount(vault, new PublicKey(mint)).toBase58();
    let to = custodyAccount;
    const s = new SolanaChain({ network: 'mainnet-beta', rpcUrl: 'http://x', mint, payer: Keypair.generate(), custody: vault.toBase58(), connection: {
      getParsedTransaction: async () => ({ meta: { err: null }, transaction: { message: { instructions: [{ program: 'spl-memo', parsed: 'fw-mint|ca_3' }, { parsed: { type: 'mintTo', info: { mint, account: to, mintAuthority: vault.toBase58(), amount: '9' } } }] } } }),
    } as any });
    expect(await s.confirmMint('sig', 'ca_3', 9)).toBe(true);
    expect(await s.confirmMint('sig', 'ca_3', 10)).toBe(false);
    expect(await s.confirmMint('sig', 'ca_', 9)).toBe(false); // the memo must match exactly
    to = Keypair.generate().publicKey.toBase58();
    expect(await s.confirmMint('sig', 'ca_3', 9)).toBe(false); // minted somewhere other than custody
  });
});

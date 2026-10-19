import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import type { TokenChain } from './plugs';

// Solana: the token is an SPL token (Token-2022), and each hour's seal is written into a transaction's memo.
//
// Who holds what:
// - FreeWater's server key pays the network fees and writes the seals. It cannot mint on the real network.
// - On the free test network (devnet) the server key may also mint, so the whole flow can be tried end to end.
// - On the real network the right to mint (and to pause the token itself) belongs to a Squads multi-signature
//   vault whose keys people hold. The server only prepares a mint; people sign it in Squads; the server then checks
//   it on the chain and records it in the books.
// - People's tokens are held in FreeWater's custody (the vault) until someone withdraws to a wallet of their own.

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export interface SolanaOptions {
  network: 'devnet' | 'mainnet-beta';
  rpcUrl: string;
  /** The token's mint address. */
  mint: string;
  token2022?: boolean;
  /** Pays fees and writes seals. */
  payer: Keypair;
  /** Devnet only: the key allowed to mint test tokens. Refused on the real network. */
  testMintAuthority?: Keypair;
  /** Who holds people's tokens: the Squads vault on the real network (the payer on devnet if not set). */
  custody?: string;
  connection?: Pick<Connection, 'getTokenSupply' | 'getTokenAccountBalance' | 'getLatestBlockhash' | 'getParsedTransaction'> & Partial<Connection>;
  /** Sends a signed transaction (replaced in tests). */
  send?: (tx: Transaction, signers: Keypair[]) => Promise<string>;
}

/** The associated token account: where a given owner's tokens of a given mint live. */
export function tokenAccount(owner: PublicKey, mint: PublicKey, program = TOKEN_2022_PROGRAM) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}
/** Create the token account if it doesn't exist yet (safe to repeat). */
export function createTokenAccountIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, program = TOKEN_2022_PROGRAM) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: tokenAccount(owner, mint, program), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}
/** Mint `amount` (base units) to a token account. */
export function mintToIx(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint, program = TOKEN_2022_PROGRAM) {
  const data = Buffer.alloc(9); data[0] = 7; data.writeBigUInt64LE(amount, 1); // MintTo
  return new TransactionInstruction({ programId: program, keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }], data });
}
export function memoIx(text: string, signer: PublicKey) {
  return new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') });
}

export class SolanaChain implements TokenChain {
  readonly name = 'solana';
  readonly network: string;
  private c: NonNullable<SolanaOptions['connection']>;
  private program: PublicKey;
  private mintKey: PublicKey;
  private custodyKey: PublicKey;
  private pausedFlag = false;
  constructor(private o: SolanaOptions) {
    if (o.network === 'mainnet-beta' && o.testMintAuthority) throw new Error('A server-held minting key is refused on the real network; minting there is signed by people in Squads.');
    this.network = o.network === 'devnet' ? 'solana-devnet' : 'solana';
    this.c = o.connection ?? new Connection(o.rpcUrl, 'confirmed');
    this.program = o.token2022 === false ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
    this.mintKey = new PublicKey(o.mint);
    this.custodyKey = new PublicKey(o.custody ?? o.payer.publicKey.toBase58());
  }
  get custodyAddress() { return this.custodyKey.toBase58(); }
  private async send(ixs: TransactionInstruction[], signers: Keypair[]) {
    const tx = new Transaction().add(...ixs);
    if (this.o.send) return this.o.send(tx, signers);
    return sendAndConfirmTransaction(this.c as Connection, tx, signers, { commitment: 'confirmed' });
  }

  /** Each hour's seal, written into a memo anyone can read on the chain. */
  async anchor(root: string, label: string) {
    return { ref: await this.send([memoIx(`fw-seal|${label}|${root}`, this.o.payer.publicKey)], [this.o.payer]) };
  }

  /**
   * Mint into custody. On devnet the server signs with the test key. On the real network it returns the prepared
   * transaction for people to sign in Squads; nothing is minted until they do.
   */
  async mint(_to: string, amount: number, ref: string): Promise<{ ref: string; prepared?: string }> {
    if (this.pausedFlag) throw new Error('Paused.');
    const dest = tokenAccount(this.custodyKey, this.mintKey, this.program);
    if (this.o.testMintAuthority) {
      const auth = this.o.testMintAuthority;
      const sig = await this.send([createTokenAccountIx(this.o.payer.publicKey, this.custodyKey, this.mintKey, this.program), mintToIx(this.mintKey, dest, auth.publicKey, BigInt(amount), this.program), memoIx(`fw-mint|${ref}`, this.o.payer.publicKey)], [this.o.payer, auth]);
      return { ref: sig };
    }
    const tx = new Transaction().add(createTokenAccountIx(this.custodyKey, this.custodyKey, this.mintKey, this.program), mintToIx(this.mintKey, dest, this.custodyKey, BigInt(amount), this.program), memoIx(`fw-mint|${ref}`, this.custodyKey));
    tx.feePayer = this.custodyKey;
    tx.recentBlockhash = (await this.c.getLatestBlockhash()).blockhash; // Squads replaces it when people sign
    return { ref: '', prepared: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') };
  }

  /** Check a mint people signed in Squads: confirmed on the chain, our memo, and the right amount. */
  async confirmMint(signature: string, ref: string, amount: number) {
    const t: any = await this.c.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
    if (!t || t.meta?.err) return false;
    const ixs: any[] = [...(t.transaction?.message?.instructions ?? []), ...((t.meta?.innerInstructions ?? []).flatMap((x: any) => x.instructions))];
    const memo = ixs.some((i) => (i.program === 'spl-memo' || i.programId?.toString() === MEMO_PROGRAM.toBase58()) && String(i.parsed ?? '').includes(`fw-mint|${ref}`));
    const minted = ixs.some((i) => (i.parsed?.type === 'mintTo' || i.parsed?.type === 'mintToChecked') && i.parsed.info?.mint === this.mintKey.toBase58() && String(i.parsed.info?.amount ?? i.parsed.info?.tokenAmount?.amount) === String(amount));
    return memo && minted;
  }

  async totalSupply() { return Number((await this.c.getTokenSupply(this.mintKey)).value.amount); }
  async balanceOf(address: string) {
    try { return Number((await this.c.getTokenAccountBalance(tokenAccount(new PublicKey(address), this.mintKey, this.program))).value.amount); } catch { return 0; }
  }
  /**
   * FreeWater's own pause: nothing more is sent from here. (The token's own pause switch, in Token-2022, is held by
   * the Squads vault and used there.) The pause is recorded on the chain in a memo, so it's public.
   */
  async setPaused(paused: boolean) { this.pausedFlag = paused; return { ref: await this.send([memoIx(`fw-pause|${paused}`, this.o.payer.publicKey)], [this.o.payer]) }; }
  async paused() { return this.pausedFlag; }
}

/** Reads a key from a setting: a JSON array of numbers (as Solana's own tools save it). */
export function keypairFrom(text: string | undefined) {
  if (!text) return undefined;
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error('A Solana key must be a JSON array of 64 numbers.');
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

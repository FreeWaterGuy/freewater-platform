import { SolanaChain, keypairFrom } from './solana';
import type { Custody } from './plugs';

/**
 * Solana from the host's settings:
 *  - the free test network: SOLANA_DEVNET_MINT, SOLANA_DEVNET_PAYER and SOLANA_DEVNET_MINT_AUTHORITY (keys as JSON
 *    arrays), SOLANA_DEVNET_RPC_URL (optional);
 *  - SOLANA_TOKEN_PROGRAM=classic for a token made with the original SPL token program (Token-2022 otherwise);
 *  - the real network: SOLANA_MINT, SOLANA_PAYER (pays fees and writes seals only), SOLANA_CUSTODY (the Squads vault
 *    that holds people's tokens and the right to mint), SOLANA_RPC_URL.
 * A minting key for the real network is never accepted.
 */
export function solanaFromEnv(env: NodeJS.ProcessEnv) {
  const devnet = env.SOLANA_DEVNET_MINT && env.SOLANA_DEVNET_PAYER
    ? new SolanaChain({ network: 'devnet', rpcUrl: env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com', mint: env.SOLANA_DEVNET_MINT, token2022: env.SOLANA_TOKEN_PROGRAM !== 'classic', payer: keypairFrom(env.SOLANA_DEVNET_PAYER)!, testMintAuthority: keypairFrom(env.SOLANA_DEVNET_MINT_AUTHORITY) })
    : undefined;
  const mainnet = env.SOLANA_MINT && env.SOLANA_PAYER && env.SOLANA_CUSTODY && env.SOLANA_RPC_URL
    ? new SolanaChain({ network: 'mainnet-beta', rpcUrl: env.SOLANA_RPC_URL, mint: env.SOLANA_MINT, token2022: env.SOLANA_TOKEN_PROGRAM !== 'classic', payer: keypairFrom(env.SOLANA_PAYER)!, custody: env.SOLANA_CUSTODY })
    : undefined;
  const vault = env.SOLANA_CUSTODY;
  const custody: Custody | undefined = vault ? { name: 'squads-vault', addressFor: async () => vault } : undefined;
  return { devnet, mainnet, custody };
}

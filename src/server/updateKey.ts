// Make the key pair that signs Model 6 software updates:  npm run key:machine-updates
// The private half goes only in the server's host settings (MACHINE_UPDATE_SIGNING_KEY); the public half goes in each
// machine's settings (FW_UPDATE_PUBLIC_KEY). Nothing is written to disk. See docs/SUPPLY-CHAIN.md.
import { newUpdateKeyPair } from '../machine/updates';

const { privateKey, publicKey } = newUpdateKeyPair();
console.log(`Server host settings only (never in the repository, a file or a chat):\nMACHINE_UPDATE_SIGNING_KEY=${privateKey}\n\nEvery machine's settings:\nFW_UPDATE_PUBLIC_KEY=${publicKey}`);

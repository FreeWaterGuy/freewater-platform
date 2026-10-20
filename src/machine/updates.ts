import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

// Signed software updates for Model 6 machines.
//
// The server holds an Ed25519 private key in the host's settings (MACHINE_UPDATE_SIGNING_KEY) and nowhere else. When
// an owner asks a machine to update, the server signs a small statement: which machine, which version, the package's
// SHA-256 when there is one, and a short time it is good for. The machine holds only the public half
// (FW_UPDATE_PUBLIC_KEY) and runs nothing it can't verify: no key set, a bad signature, another machine's update,
// an expired one, or a version that isn't newer are all refused. So a stolen API key, a hijacked server answer or a
// tampered database row can't put other software on a machine.
//
// Make a key pair with: npm run key:machine-updates

export interface UpdateManifest {
  kind: 'fw-machine-update';
  v: 1;
  locationId: string;
  version: string; // 1.2.3
  sha256: string | null; // of the package, once packages exist; the real updater checks the download against it
  issuedAt: string;
  expiresAt: string;
}
export interface SignedUpdate { manifest: string; signature: string }

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** How long a signed update may wait to be picked up (a machine offline for a day still gets it). */
export const UPDATE_VALID_MS = 3 * 24 * 3600_000;

/** A key from settings: PEM, or the base64 of its DER (PKCS#8 for the private half, SPKI for the public half). */
function readKey(text: string, half: 'private' | 'public'): KeyObject {
  const t = text.trim();
  const key = t.startsWith('-----')
    ? (half === 'private' ? createPrivateKey(t) : createPublicKey(t))
    : (half === 'private' ? createPrivateKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'pkcs8' }) : createPublicKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'spki' }));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`The ${half} update key must be an Ed25519 key.`);
  return key;
}
export const readUpdatePrivateKey = (text: string) => readKey(text, 'private');
export const readUpdatePublicKey = (text: string) => readKey(text, 'public');

/** A new key pair, as base64 DER: the private half goes in the server's settings, the public half in each machine's. */
export function newUpdateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export const newerVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  return false;
};

/** The server's side: sign an update for one machine. */
export function signUpdate(privateKey: KeyObject | string, input: { locationId: string; version: string; sha256?: string | null; now: Date }): SignedUpdate {
  if (!VERSION.test(input.version)) throw new Error('Send a version like 1.0.1');
  if (input.sha256 != null && !SHA256.test(input.sha256)) throw new Error('sha256 must be 64 lowercase hex characters.');
  const key = typeof privateKey === 'string' ? readUpdatePrivateKey(privateKey) : privateKey;
  const m: UpdateManifest = { kind: 'fw-machine-update', v: 1, locationId: input.locationId, version: input.version, sha256: input.sha256 ?? null, issuedAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + UPDATE_VALID_MS).toISOString() };
  const manifest = JSON.stringify(m);
  return { manifest, signature: sign(null, Buffer.from(manifest), key).toString('base64') };
}

export type UpdateCheck = { ok: true; manifest: UpdateManifest } | { ok: false; reason: string };

/** The machine's side: is this update signed by the key it trusts, for it, current, and newer than what it runs? */
export function checkUpdate(args: unknown, ctx: { publicKey: KeyObject | string | undefined; locationId: string; runningVersion: string; now: Date }): UpdateCheck {
  if (!ctx.publicKey) return { ok: false, reason: 'Refused: this machine has no update key set (FW_UPDATE_PUBLIC_KEY), so it can’t check updates.' };
  const a = (args ?? {}) as Partial<SignedUpdate>;
  if (typeof a.manifest !== 'string' || typeof a.signature !== 'string' || a.manifest.length > 2000 || a.signature.length > 200) return { ok: false, reason: 'Refused: the update isn’t signed.' };
  let good = false;
  try {
    const key = typeof ctx.publicKey === 'string' ? readUpdatePublicKey(ctx.publicKey) : ctx.publicKey;
    good = verify(null, Buffer.from(a.manifest), key, Buffer.from(a.signature, 'base64'));
  } catch { good = false; }
  if (!good) return { ok: false, reason: 'Refused: the update’s signature doesn’t match this machine’s update key.' };
  let m: UpdateManifest;
  try { m = JSON.parse(a.manifest); } catch { return { ok: false, reason: 'Refused: the update can’t be read.' }; }
  if (m.kind !== 'fw-machine-update' || m.v !== 1 || typeof m.version !== 'string' || !VERSION.test(m.version)) return { ok: false, reason: 'Refused: not a machine update.' };
  if (m.locationId !== ctx.locationId) return { ok: false, reason: `Refused: that update is for ${String(m.locationId).slice(0, 40)}.` };
  const now = ctx.now.getTime(), issued = Date.parse(m.issuedAt), expires = Date.parse(m.expiresAt);
  if (!(issued <= now + 5 * 60_000) || !(expires > now) || expires - issued > UPDATE_VALID_MS) return { ok: false, reason: 'Refused: the update has expired or isn’t valid yet.' };
  if (!newerVersion(m.version, ctx.runningVersion)) return { ok: false, reason: `Refused: ${m.version} isn’t newer than ${ctx.runningVersion}.` };
  return { ok: true, manifest: m };
}

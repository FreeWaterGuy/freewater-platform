import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqlClient } from '../../db/client';

/**
 * Proves a person is standing at a machine. The machine's screen shows a QR whose code changes every 30 seconds;
 * the app sends that code with "Get my free water". A code copied from a photo stops working within a minute and a half,
 * so nobody can print bottles at a machine they aren't at.
 */
export class MachinePresence {
  private secrets = new Map<string, Buffer>();
  constructor(private db: SqlClient, private clock: () => Date, readonly windowSec = 30, readonly acceptWindows = 3) {}

  private async secret(locationId: string): Promise<Buffer> {
    let s = this.secrets.get(locationId);
    if (s) return s;
    const row = (await this.db.query<{ secret: string }>(`select secret from machine_secrets where location_id = $1`, [locationId])).rows[0];
    if (row) s = Buffer.from(row.secret, 'hex');
    else {
      s = randomBytes(32);
      await this.db.query(`insert into machine_secrets (location_id, secret) values ($1,$2) on conflict (location_id) do nothing`, [locationId, s.toString('hex')]);
      s = Buffer.from((await this.db.query<{ secret: string }>(`select secret from machine_secrets where location_id = $1`, [locationId])).rows[0]!.secret, 'hex');
    }
    this.secrets.set(locationId, s);
    return s;
  }

  private codeAt(secret: Buffer, locationId: string, window: number) {
    return createHmac('sha256', secret).update(`${locationId}:${window}`).digest('hex').slice(0, 10);
  }

  /** The code the machine shows right now, and how long until it changes. */
  async current(locationId: string) {
    const t = this.clock().getTime() / 1000;
    const w = Math.floor(t / this.windowSec);
    return { code: this.codeAt(await this.secret(locationId), locationId, w), changesInSec: Math.ceil((w + 1) * this.windowSec - t) };
  }

  async check(locationId: string, code: string): Promise<boolean> {
    if (!/^[0-9a-f]{10}$/.test(code)) return false;
    const secret = await this.secret(locationId);
    const w = Math.floor(this.clock().getTime() / 1000 / this.windowSec);
    for (let i = 0; i < this.acceptWindows; i++) {
      if (timingSafeEqual(Buffer.from(this.codeAt(secret, locationId, w - i)), Buffer.from(code))) return true;
    }
    return false;
  }
}

import { createHash } from 'node:crypto';
import { newId } from '../../core/ids';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { BlobStore } from '../assets/blobs';
import { getChecked } from '../assets/blobs';
import { readImage, MAX_PIXELS } from '../studio/photos';
import { DeliveryError } from './errors';
import { deliverySettings } from './settings';
import { distanceKm, type GeoPoint } from '../../adapters/geocoding/contract';

/**
 * Photo proof of each drop (docs/SWITCHES.md, Delivery; the founder: "drop off the pack and take a photo of it on the
 * doorstep, and then we know it's delivered"). A photo is taken for one pack, at the door, by the driver delivering it.
 *
 * It shows someone's home, so:
 *  - it is re-encoded on the way in (turned upright, at most 1600 pixels a side, JPEG): whatever the phone hid in the
 *    file (where it was taken, which phone, the owner) is left behind;
 *  - only the team sees it, and someone who proved in the app that the house is theirs (or the subscriber, for their
 *    own delivery). Never advertisers: their report keeps street-level proof only;
 *  - its picture is deleted after the company's keep (90 days unless set: `delivery.photoKeepDays`), by the
 *    drop-photos job, whatever the switches say. The row stays (that a photo was taken, when), the picture doesn't.
 */
export const DEFAULT_PHOTO_KEEP_DAYS = 90;
export const MAX_PHOTO_UPLOAD_BYTES = 8 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIDE = 1600;

export interface DropPhoto { id: string; packId: string; runId: string | null; stop: number | null; houseId: string | null; takenBy: string; takenAt: string; deleted: boolean; location: 'verified' | 'unverified' | null; metersFromHouse: number | null }

export class DropPhotoService {
  constructor(private db: SqlClient, private platform: Platform, private blobs?: BlobStore, private clock: () => Date = () => new Date()) {}

  keepDays(companyId: string) {
    const d = this.platform.companies.get(companyId)?.delivery?.photoKeepDays;
    return typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 365 ? d : DEFAULT_PHOTO_KEEP_DAYS;
  }

  private view(r: any): DropPhoto {
    return { id: r.id, packId: r.pack_id, runId: r.run_id ?? null, stop: r.stop === null ? null : Number(r.stop), houseId: r.house_id ?? null, takenBy: r.taken_by, takenAt: new Date(r.taken_at).toISOString(), deleted: !!r.deleted_at,
      location: r.location_check ?? null, metersFromHouse: r.meters_from_house === null || r.meters_from_house === undefined ? null : Number(r.meters_from_house) };
  }

  /**
   * The driver's photo of a pack at the door. Only a picture (JPEG, PNG or WebP, by its contents, not its name), up to
   * 8 MB and 40 megapixels; stored re-encoded without the phone's hidden data. Taken with the driver app's camera (not
   * picked from the phone's photos: `capture: 'camera'`, which only the app's camera button sends). Where the phone was
   * when it was taken, when it says: within the company's distance of the house (`delivery.photoMaxMeters`, 150 m
   * unless set) it's a verified place; farther, it's refused (take it at the house); no location, or one too vague to
   * tell, and it counts but is marked "unverified location" for the team. It proves a drop only if it was taken after
   * the box was scanned at that door (DeliveryService.deliver).
   */
  async put(input: { companyId: string; packId: string; takenBy: string; contentType: string; bytes: Uint8Array; capture: 'camera' | 'upload'; point?: { lat: number; lng: number }; accuracyM?: number }) {
    const pack = this.packOf(input.companyId, input.packId);
    if (!pack) throw new DeliveryError(404, 'not_found', 'No such box.');
    if (pack.status !== 'loaded') throw new DeliveryError(409, 'not_out', 'Take the photo when the box is at the door (it isn’t out on a van).');
    if (input.capture !== 'camera') throw new DeliveryError(422, 'camera_only', 'Take the photo with the driver app’s camera, at the door. A photo from the phone’s gallery doesn’t count.');
    const house = await this.placeOf?.(input.companyId, pack);
    const max = deliverySettings(this.platform.companies.get(input.companyId)).photoMaxMeters;
    const p = input.point && Number.isFinite(input.point.lat) && Number.isFinite(input.point.lng) && Math.abs(input.point.lat) <= 90 && Math.abs(input.point.lng) <= 180 ? input.point : null;
    const meters = p && house ? Math.round(distanceKm(p, house) * 1000) : null;
    const vague = typeof input.accuracyM === 'number' && input.accuracyM > max;
    if (meters !== null && !vague && meters > max) throw new DeliveryError(409, 'too_far', `Your phone puts you ${meters} m from ${pack.address?.split(',')[0] ?? 'the house'}. Take the photo at the door (within ${max} m).`);
    const location: 'verified' | 'unverified' = meters !== null && !vague ? 'verified' : 'unverified';
    if (!TYPES.includes(input.contentType)) throw new DeliveryError(415, 'unsupported_type', 'Send a photo: JPEG, PNG or WebP.');
    if (!input.bytes.length) throw new DeliveryError(422, 'empty_file', 'That photo is empty.');
    if (input.bytes.length > MAX_PHOTO_UPLOAD_BYTES) throw new DeliveryError(413, 'too_large', 'That photo is too big (8 MB at most).');
    const clean = await this.reencode(input.bytes);
    const id = newId('dph');
    const sha = createHash('sha256').update(clean).digest('hex');
    const key = this.blobs ? `drop-photos/${input.companyId}/${id}` : null;
    if (this.blobs && key) await this.blobs.put(key, clean, 'image/jpeg'); // stored first: a row never points at nothing
    const at = this.clock().toISOString();
    await this.db.query(`insert into drop_photos (id, company_id, pack_id, run_id, stop, house_id, customer_id, taken_by, content_type, bytes, blob_key, size_bytes, sha256, taken_at, capture, lat, lng, meters_from_house, location_check) values ($1,$2,$3,$4,$5,$6,$7,$8,'image/jpeg',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, input.companyId, pack.id, pack.runId ?? null, pack.stop, pack.houseId ?? null, pack.houseId ? null : pack.customerId || null, input.takenBy, key ? null : Buffer.from(clean), key, clean.length, sha, at, input.capture, p?.lat ?? null, p?.lng ?? null, meters, location]);
    return { id, takenAt: at, location, metersFromHouse: meters };
  }

  private packOf(companyId: string, packId: string) {
    const p = this.packs?.get(packId);
    return p && p.companyId === companyId ? p : null;
  }
  /** The packs in memory. Set by the app. */
  packs?: Map<string, import('../packs/service').Pack>;
  /** Where a pack's door is (its stop on its run). Set by the app. */
  placeOf?: (companyId: string, pack: import('../packs/service').Pack) => Promise<GeoPoint | null>;

  /** Upright, at most 1600 pixels a side, JPEG: nothing hidden in the phone's file is kept (sharp drops it unless asked). */
  private async reencode(bytes: Uint8Array) {
    let out: Buffer;
    try {
      const meta = await readImage(bytes).metadata();
      if (!meta.width || !meta.height) throw new Error('unreadable');
      if (meta.width * meta.height > MAX_PIXELS) throw new DeliveryError(413, 'too_many_pixels', 'That photo is too big (40 megapixels at most).');
      out = await readImage(bytes).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#FFFFFF' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      throw new DeliveryError(422, 'not_a_photo', 'That file isn’t a photo we can read. Take it again in the driver app.');
    }
    return new Uint8Array(out);
  }

  /** Where the photos of a pack are up to: the box's scan at the door remembers it, and only a photo after it counts. */
  async lastSeq(companyId: string, packId: string): Promise<number> {
    return Number((await this.db.query<any>(`select coalesce(max(seq), 0)::bigint as s from drop_photos where company_id = $1 and pack_id = $2`, [companyId, packId])).rows[0]?.s ?? 0);
  }

  /**
   * The newest photo this person took of this pack after the box's scan at the door (`afterSeq`, from lastSeq then),
   * still kept: the proof a drop needs. No scan at the door yet: no photo counts.
   */
  async proofFor(companyId: string, packId: string, takenBy: string, afterSeq: number | null | undefined): Promise<DropPhoto | null> {
    if (afterSeq === null || afterSeq === undefined) return null;
    const r = (await this.db.query<any>(`select id, pack_id, run_id, stop, house_id, taken_by, taken_at, deleted_at, location_check, meters_from_house from drop_photos where company_id = $1 and pack_id = $2 and taken_by = $3 and deleted_at is null and seq > $4 order by seq desc limit 1`, [companyId, packId, takenBy, afterSeq])).rows[0];
    return r ? this.view(r) : null;
  }

  async get(companyId: string, id: string): Promise<(DropPhoto & { customerId: string | null }) | null> {
    const r = (await this.db.query<any>(`select id, pack_id, run_id, stop, house_id, customer_id, taken_by, taken_at, deleted_at from drop_photos where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    return r ? { ...this.view(r), customerId: r.customer_id ?? null } : null;
  }

  /** The picture itself, or null once it was deleted (or never was). */
  async bytes(companyId: string, id: string): Promise<Uint8Array | null> {
    const r = (await this.db.query<any>(`select bytes, blob_key, sha256, deleted_at from drop_photos where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r || r.deleted_at) return null;
    if (r.blob_key) return this.blobs ? getChecked(this.blobs, r.blob_key, r.sha256) : null;
    return r.bytes ? new Uint8Array(r.bytes) : null;
  }

  /**
   * Photos someone may see as a resident: drops at the house they proved is theirs, from when they proved it on (never
   * before: whoever lived there then, or a passer-by who claimed the house, sees nothing of the door's past); and drops
   * of their own subscription. Newest first, at most 20.
   */
  async forResident(companyId: string, userId: string) {
    const rows = (await this.db.query<any>(
      `select p.id, p.pack_id, p.run_id, p.stop, p.house_id, p.taken_by, p.taken_at, p.deleted_at from drop_photos p
       where p.company_id = $1 and p.deleted_at is null and (p.customer_id = $2 or exists (select 1 from house_claims c where c.house_id = p.house_id and c.user_id = $2 and c.company_id = $1 and p.taken_at >= c.claimed_at))
       order by p.taken_at desc limit 20`, [companyId, userId])).rows;
    return rows.map((r) => ({ id: r.id as string, takenAt: new Date(r.taken_at).toISOString(), url: `/v1/me/drop-photos/${r.id}` }));
  }

  /** May this person see this photo as a resident? (The same rule as forResident.) */
  async residentMay(companyId: string, userId: string, id: string) {
    return !!(await this.db.query<any>(
      `select 1 from drop_photos p where p.id = $3 and p.company_id = $1 and (p.customer_id = $2 or exists (select 1 from house_claims c where c.house_id = p.house_id and c.user_id = $2 and c.company_id = $1 and p.taken_at >= c.claimed_at))`, [companyId, userId, id])).rows.length;
  }

  /** Deletes one picture: its file first, then the picture in its record (a file that can't be removed throws, the record stays). */
  private async deletePicture(r: { id: string; blob_key: string | null }) {
    if (r.blob_key && this.blobs) await this.blobs.delete(r.blob_key);
    const done = await this.db.query(`update drop_photos set bytes = null, blob_key = null, deleted_at = $2 where id = $1 and deleted_at is null`, [r.id, this.clock().toISOString()]);
    return Number((done as any).rowCount ?? 1);
  }

  /**
   * A subscriber erasing their data: the pictures of their own deliveries (their front door, tied to their account) go
   * at once, not at the end of the keep. Photos at a house in a delivery area are the company's record of a drop at an
   * address, seen by whoever lives there now; they stay until the keep ends.
   */
  async eraseFor(companyId: string, userIds: string[]) {
    if (!userIds.length) return 0;
    // Like the rest of an erase (SqlAssetStore.removeForUsers): never reported done while a photo of their door is
    // still in file storage. Each is tried; any left fail the erase, saying so, and the next try finds them again.
    let n = 0, stuck = 0, firstError = '';
    for (const r of (await this.db.query<any>(`select id, blob_key from drop_photos where company_id = $1 and customer_id = any($2) and deleted_at is null`, [companyId, userIds])).rows) {
      try { n += await this.deletePicture(r); } catch (e) { stuck++; firstError ||= String((e as Error)?.message ?? e); }
    }
    if (stuck) throw new Error(`${stuck} door photo${stuck === 1 ? '' : 's'} of their deliveries couldn't be deleted from file storage (${firstError}); ${n} deleted. Erase again once file storage answers.`);
    return n;
  }

  /**
   * Delete the pictures kept longer than each company's keep, oldest first. Safe to run again (a deleted picture is
   * skipped). A picture whose file can't be removed now keeps its record, so the next run finds it again; and the run
   * then fails, so the job's alert says photos of people's homes are being kept past their time.
   */
  async purge(): Promise<number> {
    let n = 0, stuck = 0;
    let firstError = '';
    const gone = async (key: string | null) => {
      if (!key || !this.blobs) return true;
      try { await this.blobs.delete(key); return true; } catch (e) { stuck++; firstError ||= String((e as Error)?.message ?? e); return false; }
    };
    for (const c of this.platform.companies.values()) {
      const before = new Date(this.clock().getTime() - this.keepDays(c.id) * 86_400_000).toISOString();
      const rows = (await this.db.query<any>(`select id, blob_key from drop_photos where company_id = $1 and deleted_at is null and taken_at < $2 order by taken_at limit 5000`, [c.id, before])).rows;
      for (const r of rows) {
        try { n += await this.deletePicture(r); } catch (e) { stuck++; firstError ||= String((e as Error)?.message ?? e); }
      }
      // Photos taken before 065 were kept with the uploads (assets): the same keep applies to them. The file goes
      // first, then its record, so a file that can't be removed now is never left behind with nothing pointing at it.
      const old = (await this.db.query<any>(`select id, blob_key from assets where company_id = $1 and name = 'delivery-photo' and created_at < $2 order by created_at limit 5000`, [c.id, before])).rows;
      for (const r of old) {
        if (!(await gone(r.blob_key))) continue;
        n += Number((await this.db.query(`delete from assets where id = $1`, [r.id])).rowCount ?? 1);
      }
    }
    if (stuck) throw new Error(`${stuck} door photo${stuck === 1 ? '' : 's'} past ${stuck === 1 ? 'its' : 'their'} keep couldn't be deleted from file storage (${firstError}); ${n} deleted. They're tried again on the next run. Check the file storage settings (FILE_STORAGE) and docs/RUNBOOKS.md ("Door photos").`);
    return n;
  }
}

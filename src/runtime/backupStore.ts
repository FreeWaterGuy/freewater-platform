import { DiskBlobStore, S3BlobStore, type BlobStore } from '../modules/assets/blobs';

/**
 * Where backups go: separate from the database host, and ideally from the files too (another bucket, another account).
 *   BACKUP_S3_BUCKET (+ BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY)
 *   or BACKUP_DIR for a folder (testing only).
 * Set the bucket to keep each copy 30 days or more and to refuse deletes in that time ("object lock"), so even someone
 * with the server's keys can't erase them.
 */
export function backupStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  if (env.BACKUP_S3_BUCKET) return new S3BlobStore({ bucket: env.BACKUP_S3_BUCKET, region: env.BACKUP_S3_REGION ?? 'auto', endpoint: env.BACKUP_S3_ENDPOINT, accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY ?? '' });
  if (env.BACKUP_DIR) return new DiskBlobStore(env.BACKUP_DIR);
  throw new Error('Set BACKUP_S3_BUCKET (and its keys) or BACKUP_DIR so backups have somewhere to go.');
}
export const backupsConfigured = (env: NodeJS.ProcessEnv = process.env) => !!env.BACKUP_KEY && !!(env.BACKUP_S3_BUCKET || env.BACKUP_DIR);

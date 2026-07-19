// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// S3-compatible storage provider (plan item 51). Thin adapter over the proven
// S3 client in services/cdn.service.js — AWS S3, Cloudflare R2, Backblaze B2,
// Vultr, MinIO all work via S3_ENDPOINT/S3_* env (see PORTABILITY.md). No new
// client, no duplicated config: cdn.service stays the single S3 touchpoint.
import { StorageProvider } from './StorageProvider.interface.js';
import { isS3Configured, uploadBufferToS3, deleteFile, generatePresignedDownloadUrl } from '../../services/cdn.service.js';

export class S3StorageProvider extends StorageProvider {
  get id() { return 's3'; }

  isAvailable() { return isS3Configured(); }

  async upload(key, buffer, contentType) {
    const url = await uploadBufferToS3(key, buffer, contentType);
    return { url, key };
  }

  async getUrl(key) {
    const { downloadUrl, expiresAt } = await generatePresignedDownloadUrl(key);
    return { url: downloadUrl, expiresAt };
  }

  async delete(key) {
    await deleteFile(key);
    return { success: true };
  }
}

// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * StorageProvider.interface.js — Storage Abstraction (plan item 51). 2026-07-13.
 *
 * Object storage behind one interface, same pattern as the payment/casino/
 * sportsbook providers in backend/providers/. Business logic that stores
 * files goes through providerRegistry.storage.get(...) and never knows
 * whether bytes land on S3/R2/Backblaze/MinIO or local disk.
 *
 * Implementations: S3StorageProvider (any S3-compatible endpoint — wraps the
 * proven client in services/cdn.service.js) and LocalDiskStorageProvider
 * (single-instance dev fallback). server.js registers whichever the
 * environment supports at boot (S3 preferred when configured).
 *
 * To add a provider (GCS native, Azure Blob, ...):
 *  1. Create a class extending StorageProvider implementing every method.
 *  2. Register it in server.js's registerCoreServices alongside the others.
 */
export class StorageProvider {
  /** Stable id, e.g. 's3', 'local'. */
  get id() { throw new Error('StorageProvider.id not implemented'); }
  get version() { return '1.0.0'; }

  /** True when this provider can actually serve (creds present, dir writable). */
  isAvailable() { return false; }

  /**
   * Store a Buffer at a deterministic key. Overwrites. Returns the PUBLIC url.
   * @param {string} key e.g. 'app-assets/logo.png'
   * @param {Buffer} buffer
   * @param {string} contentType
   * @returns {Promise<{ url: string, key: string }>}
   */
  async upload(key, buffer, contentType) { throw new Error(`${this.id}: upload not implemented`); }

  /** @returns {Promise<{ url: string, expiresAt?: string }>} short-lived read url */
  async getUrl(key) { throw new Error(`${this.id}: getUrl not implemented`); }

  /** @returns {Promise<{ success: boolean }>} */
  async delete(key) { throw new Error(`${this.id}: delete not implemented`); }
}

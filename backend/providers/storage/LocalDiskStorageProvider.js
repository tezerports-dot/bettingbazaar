// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Local-disk storage provider (plan item 51) — the graceful fallback when no
// S3-compatible store is configured. Files land under backend/storage/ and are
// served by the /storage static mount in server.js. Single-instance only
// (ephemeral on container hosts) — the same honest limitation the app-asset
// disk fallback documents; S3 is the multi-instance path.
import fs from 'fs';
import path from 'path';
import { StorageProvider } from './StorageProvider.interface.js';

const BASE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '../../storage');

function safeJoin(key) {
  // Prevent path traversal: resolve inside BASE_DIR or refuse.
  const p = path.normalize(path.join(BASE_DIR, key));
  if (!p.startsWith(BASE_DIR)) throw new Error('Invalid storage key');
  return p;
}

export class LocalDiskStorageProvider extends StorageProvider {
  get id() { return 'local'; }

  isAvailable() {
    try { fs.mkdirSync(BASE_DIR, { recursive: true }); return true; }
    catch { return false; }
  }

  async upload(key, buffer /*, contentType */) {
    const p = safeJoin(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buffer);
    return { url: `/storage/${key}`, key };
  }

  async getUrl(key) {
    safeJoin(key); // validates
    return { url: `/storage/${key}` };
  }

  async delete(key) {
    const p = safeJoin(key);
    try { fs.unlinkSync(p); } catch { /* already gone */ }
    return { success: true };
  }
}

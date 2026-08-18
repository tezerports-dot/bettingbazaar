#!/usr/bin/env node
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * migrate-kyc-to-private.mjs — move legacy KYC documents off the public CDN.
 *
 * THE HOLE THIS CLOSES
 * KYC now uploads identity documents to a PRIVATE bucket and stores an object
 * KEY (kycData.idProofKey / photoKey), reviewed via short-lived presigned GETs.
 * But users who submitted BEFORE that change still have their Aadhaar/PAN/selfie
 * sitting at a PUBLIC CDN URL (kycData.idProofUrl / photoUrl) — anyone with the
 * link can open them. This script pulls each legacy document into the private
 * bucket, writes the key back onto the user (which mirrors to Postgres via the
 * User post-save hook), and — once you're satisfied — nulls the public URL.
 *
 * SAFE BY CONSTRUCTION
 *   • DRY-RUN by default. It reports what it would do and changes nothing until
 *     you pass --apply. Nothing about identity documents should move on a typo.
 *   • IDEMPOTENT. A document that already has a private key is skipped, so the
 *     script is safe to re-run and to resume after an interruption.
 *   • NON-DESTRUCTIVE by default. The public URL is KEPT (rollback safety) unless
 *     you pass --clear-urls — run that only AFTER a review pass confirms the
 *     private copies open correctly.
 *   • BOUNDED. Batched with small concurrency; --limit caps a trial run.
 *
 * USAGE (staging first, then production — never point a half-tested run at prod)
 *   node backend/scripts/migrate-kyc-to-private.mjs                # dry-run, all
 *   node backend/scripts/migrate-kyc-to-private.mjs --limit 20     # dry-run, 20
 *   node backend/scripts/migrate-kyc-to-private.mjs --apply        # migrate
 *   node backend/scripts/migrate-kyc-to-private.mjs --apply --clear-urls  # + null the old URLs
 *
 * ENV: MONGODB_URI, the KYC_S3_* private-bucket vars (see kycDocuments.service.js),
 *      and optionally PUBLIC_KYC_BASE_URL / CDN_URL if the stored value is a path
 *      rather than a full URL.
 */
import mongoose from 'mongoose';
import { User } from '../models/index.js';
import { configured, putDocumentObject } from '../services/kycDocuments.service.js';

const APPLY      = process.argv.includes('--apply');
const CLEAR_URLS = process.argv.includes('--clear-urls');
const LIMIT      = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1])
               || Number(process.argv[process.argv.indexOf('--limit') + 1]) || 0;
const CONCURRENCY = Math.max(1, Number(process.env.KYC_MIGRATE_CONCURRENCY) || 4);
const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_CT = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXT_CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// The two documents a user can carry, each as {urlField, keyField, docType}.
const DOCS = [
  { urlField: 'idProofUrl', keyField: 'idProofKey', docType: 'id_proof' },
  { urlField: 'photoUrl',   keyField: 'photoKey',   docType: 'photo' },
];

const stats = { users: 0, docsFound: 0, migrated: 0, skipped: 0, failed: 0, urlsCleared: 0 };

/** A stored value may be a full URL or a bare path; resolve to something fetchable. */
function resolveUrl(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const base = (process.env.PUBLIC_KYC_BASE_URL || process.env.CDN_URL || '').replace(/\/+$/, '');
  return base ? `${base}/${v.replace(/^\/+/, '')}` : null;
}

function contentTypeOf(res, url) {
  const hdr = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_CT.has(hdr)) return hdr;
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  return EXT_CT[ext] || null;
}

async function fetchDocument(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = contentTypeOf(res, url);
    if (!contentType) throw new Error(`unsupported content-type (not jpg/png/webp)`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0) throw new Error('empty body');
    if (body.length > MAX_BYTES) throw new Error(`too large (${body.length} bytes)`);
    return { body, contentType };
  } finally {
    clearTimeout(t);
  }
}

/** Migrate one document for one user. Returns true if the user doc was changed. */
async function migrateDoc(user, { urlField, keyField, docType }) {
  const kyc = user.kycData || {};
  if (kyc[keyField]) return false;                 // already private — idempotent skip
  const rawUrl = kyc[urlField];
  if (!rawUrl) return false;                        // nothing to migrate

  stats.docsFound++;
  const url = resolveUrl(rawUrl);
  if (!url) { console.warn(`  ✗ ${user._id} ${docType}: cannot resolve URL '${rawUrl}'`); stats.failed++; return false; }

  if (!APPLY) {
    console.log(`  • [dry-run] ${user._id} ${docType}: would fetch ${url} → private key`);
    stats.migrated++;
    return false;
  }

  try {
    const { body, contentType } = await fetchDocument(url);
    const { key } = await putDocumentObject({ userId: String(user._id), docType, contentType, body });
    user.kycData[keyField] = key;
    if (CLEAR_URLS) { user.kycData[urlField] = undefined; stats.urlsCleared++; }
    console.log(`  ✓ ${user._id} ${docType}: ${body.length}B → ${key}`);
    stats.migrated++;
    return true;
  } catch (err) {
    console.warn(`  ✗ ${user._id} ${docType}: ${err.message}`);
    stats.failed++;
    return false;
  }
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI');
  if (APPLY && !configured()) {
    throw new Error('KYC private bucket is not configured (KYC_S3_* env). Refusing to --apply.');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`KYC migration — ${APPLY ? 'APPLY' : 'DRY-RUN'}${CLEAR_URLS ? ' +clear-urls' : ''}${LIMIT ? ` (limit ${LIMIT})` : ''}`);

  // select:false fields must be opted in explicitly.
  const projection = '+kycData.idProofUrl +kycData.photoUrl +kycData.idProofKey +kycData.photoKey';
  const query = {
    $or: [
      { 'kycData.idProofUrl': { $nin: [null, ''] }, 'kycData.idProofKey': { $in: [null, ''] } },
      { 'kycData.photoUrl':   { $nin: [null, ''] }, 'kycData.photoKey':   { $in: [null, ''] } },
    ],
  };

  const cursor = User.find(query).select(projection).sort({ _id: 1 }).cursor();
  let batch = [];
  const flush = async () => {
    await Promise.all(batch.map(async (user) => {
      stats.users++;
      let changed = false;
      for (const doc of DOCS) changed = (await migrateDoc(user, doc)) || changed;
      if (changed && APPLY) {
        try { await user.save(); }                 // post-save hook mirrors the keys to Postgres
        catch (e) { console.error(`  ! ${user._id}: save failed — ${e.message}`); stats.failed++; }
      }
    }));
    batch = [];
  };

  for await (const user of cursor) {
    batch.push(user);
    if (LIMIT && stats.users + batch.length > LIMIT) { batch.pop(); break; }
    if (batch.length >= CONCURRENCY) await flush();
  }
  await flush();

  console.log('\n── summary ──');
  console.table(stats);
  if (!APPLY) console.log('DRY-RUN only — re-run with --apply to migrate. (Keep the public URLs until a review pass confirms the private copies.)');
  await mongoose.disconnect();
}

run().catch((e) => { console.error('KYC migration failed:', e); process.exit(1); });

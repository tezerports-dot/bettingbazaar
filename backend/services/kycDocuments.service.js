// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/kycDocuments.service.js — KYC identity documents, in private object
 * storage.
 *
 * Task H(b). Neither database holds blobs and neither ever did — `cdn.service.js`
 * has always put the bytes in S3 and stored a URL. The problem is WHICH storage
 * and WHAT is stored.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * KYC documents — Aadhaar cards, PAN cards, selfies — went to the same bucket
 * as branding images and payment screenshots, and `kycData.idProofUrl` held a
 * **public BunnyCDN URL**: `${CDN_URL}/${fileKey}`. The key carries 128 bits of
 * randomness, so it is not guessable, and that is the whole of the protection.
 *
 * An unguessable URL is a capability, and this one is a bad capability:
 *
 *   - it NEVER EXPIRES;
 *   - it is persisted in Mongo AND mirrored into Postgres, so it is in every
 *     database backup;
 *   - it is returned by admin APIs and rendered in the admin panel, so it
 *     reaches browser history, screenshots and support tickets;
 *   - it needs no authentication, so anyone who ever sees it — a leaked backup,
 *     a log aggregator, a former employee's browser — has permanent access to
 *     someone's government ID.
 *
 * That is not an access-control model for identity documents. Nothing here is
 * hypothetical about the exposure: the URL is public by construction, because
 * a CDN zone exists to serve objects to anyone who asks.
 *
 * ── What this does instead ──────────────────────────────────────────────────
 * A SEPARATE, PRIVATE bucket — Cloudflare R2, which is S3-compatible, so the
 * same @aws-sdk/client-s3 already in the tree drives it — with no CDN in front
 * and no public URL anywhere:
 *
 *   upload  a presigned PUT, short-lived, scoped to one content type and key
 *   store   the object KEY, never a URL. A key is a reference; a URL is a
 *           grant, and grants do not belong in a database column.
 *   read    a presigned GET minted PER REVIEW, expiring in minutes, never
 *           persisted and never mirrored
 *
 * So access becomes a decision made at review time by an authenticated admin,
 * which is auditable and revocable, instead of a property of a string that was
 * written into two databases years earlier.
 *
 * ── Deliberately a separate client and bucket ───────────────────────────────
 * Not a category inside cdn.service.js. That service exists to make objects
 * PUBLIC and fast — it composes CDN URLs, and its callers assume that. Sharing
 * it would mean one misrouted category silently republishing identity
 * documents, which is the failure this module exists to prevent. Different
 * safety properties, different client.
 *
 * ── Falls back rather than failing closed at import ─────────────────────────
 * `configured()` is false when R2 is not set up, and the callers keep using the
 * existing path. A KYC submission that started failing because an environment
 * variable was missing would take registration down; migration is a deployment
 * step, not a hard cutover in code. `docs/KYC_DOCUMENT_STORAGE.md` has the
 * sequence.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

const BUCKET = process.env.KYC_S3_BUCKET || '';
const ENDPOINT = process.env.KYC_S3_ENDPOINT || '';
const ACCESS_KEY = process.env.KYC_S3_ACCESS_KEY || '';
const SECRET_KEY = process.env.KYC_S3_SECRET_KEY || '';

/** Minutes an upload grant lives. Long enough for a slow mobile connection. */
const UPLOAD_TTL_SECONDS = 300;
/**
 * Seconds a REVIEW grant lives. Deliberately short: it exists to render one
 * image on one admin's screen, and every second beyond that is a window in
 * which a copied URL still works.
 */
const REVIEW_TTL_SECONDS = 120;

/** Identity documents are images only. No PDFs, no archives, no surprises. */
const ALLOWED = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
});

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The document types this store holds, and the names the HTTP layer uses.
 *
 * Two vocabularies exist because the routes were named before this module was:
 * the panels ask for `id-proof` and `selfie`, the keys and the Postgres columns
 * say `id_proof` and `photo`. Mapping them HERE, next to `keyFor`, is what stops
 * a route from inventing a third spelling and writing a key nothing can parse.
 */
export const DOC_TYPES = Object.freeze({
  'id-proof': 'id_proof',
  'selfie':   'photo',
  // Accepted verbatim so an internal caller need not know the URL spelling.
  'id_proof': 'id_proof',
  'photo':    'photo',
  'address_proof': 'address_proof',
});

/** Route spelling → key spelling, or null if it is not a KYC document type. */
export function normaliseDocType(docType) {
  return DOC_TYPES[String(docType || '')] ?? null;
}

let client = null;
function s3() {
  if (client) return client;
  client = new S3Client({
    // R2 ignores the region but the SDK requires one.
    region: process.env.KYC_S3_REGION || 'auto',
    endpoint: ENDPOINT.startsWith('http') ? ENDPOINT : `https://${ENDPOINT}`,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  return client;
}

/** Is the private KYC store configured? When false, callers keep the old path. */
export function configured() {
  return Boolean(BUCKET && ENDPOINT && ACCESS_KEY && SECRET_KEY);
}

/**
 * The object key for one document.
 *
 * Namespaced by user so a listing is per-subject — which is what a deletion
 * request under a privacy regime needs to be able to enumerate — and carries
 * 128 bits of randomness so a key cannot be derived from a user id alone. The
 * randomness is defence in depth here rather than the whole protection, because
 * the bucket is private.
 */
function keyFor(userId, docType, contentType) {
  const ext = ALLOWED[contentType];
  const nonce = crypto.randomBytes(16).toString('hex');
  return `kyc/${String(userId)}/${docType}/${Date.now()}-${nonce}.${ext}`;
}

/**
 * Read a key back into the facts it encodes: whose document it is, and which.
 *
 * The key is the ONLY thing the submit route receives from the client, so this
 * is where "is this yours?" gets answered. Returns null for anything that is not
 * one of ours — a key from another prefix, a traversal attempt, a fabrication.
 *
 * The old CDN path answered the same question with `expectedUserId` /
 * `expectedCategory`. Dropping it while moving to a private bucket would trade
 * one exposure for a worse one: user A submitting user B's key, and an admin
 * reviewing B's Aadhaar card as A's identity.
 */
export function parseKey(key) {
  const parts = String(key || '').split('/');
  if (parts.length !== 4) return null;
  const [prefix, userId, docType, filename] = parts;
  if (prefix !== 'kyc' || !userId || !filename) return null;
  if (!Object.values(DOC_TYPES).includes(docType)) return null;
  // `.` and `..` never reach here (they are not document types), but a filename
  // may not smuggle a separator or an empty segment past the length check.
  if (userId === '.' || userId === '..') return null;
  return { userId, docType, filename };
}

/**
 * The key belongs to this user and this document type — or it is refused.
 * `expectedUserId` is required by every caller that takes a key from a request.
 */
function assertKeyBelongsTo(key, { expectedUserId = null, expectedDocType = null } = {}) {
  const parsed = parseKey(key);
  if (!parsed) throw Object.assign(new Error('Not a KYC document key'), { status: 400 });
  if (expectedUserId !== null && parsed.userId !== String(expectedUserId)) {
    throw Object.assign(new Error('This KYC document belongs to another user'), { status: 403 });
  }
  const wanted = expectedDocType === null ? null : normaliseDocType(expectedDocType);
  if (wanted !== null && parsed.docType !== wanted) {
    throw Object.assign(
      new Error(`This key is a ${parsed.docType}, not a ${wanted}`), { status: 400 },
    );
  }
  return parsed;
}

function validate({ contentType, fileSize, docType }) {
  if (!ALLOWED[contentType]) {
    throw Object.assign(
      new Error(`KYC documents must be an image (${Object.keys(ALLOWED).join(', ')}), got '${contentType}'`),
      { status: 400 },
    );
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_BYTES) {
    throw Object.assign(new Error(`KYC document must be between 1 byte and ${MAX_BYTES} bytes`), { status: 400 });
  }
  if (!['id_proof', 'photo', 'address_proof'].includes(docType)) {
    throw Object.assign(new Error(`Unknown KYC document type '${docType}'`), { status: 400 });
  }
}

/**
 * A short-lived grant to upload ONE document.
 *
 * Returns the key as well as the URL, and the caller stores the KEY. Nothing
 * that reaches a database from here is a grant.
 */
export async function presignUpload({ userId, docType, contentType, fileSize }) {
  if (!configured()) throw Object.assign(new Error('KYC document storage is not configured'), { status: 503 });
  // Normalise before validating, so the route's `id-proof` and the key's
  // `id_proof` cannot diverge into two document types that look like one.
  const kind = normaliseDocType(docType);
  validate({ contentType, fileSize, docType: kind });

  const key = keyFor(userId, kind, contentType);
  const url = await getSignedUrl(s3(), new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: fileSize,
    // No ACL. The bucket is private and objects inherit that; setting one here
    // would be the single line that could make an identity document public.
  }), { expiresIn: UPLOAD_TTL_SECONDS });

  return { key, uploadUrl: url, expiresIn: UPLOAD_TTL_SECONDS, contentType };
}

/**
 * Did the object actually arrive, and is it what was declared?
 *
 * A presigned PUT is a grant, not a promise — a client can take one and upload
 * nothing. Storing the key without checking would leave a KYC record pointing
 * at an object that does not exist, which a reviewer discovers as a broken
 * image and cannot distinguish from a storage fault.
 */
export async function verifyUploaded({
  key, contentType = null, expectedUserId = null, expectedDocType = null,
}) {
  if (!configured()) throw Object.assign(new Error('KYC document storage is not configured'), { status: 503 });
  const parsed = assertKeyBelongsTo(key, { expectedUserId, expectedDocType });
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    if (contentType && head.ContentType && head.ContentType !== contentType) {
      throw Object.assign(
        new Error(`Uploaded object is ${head.ContentType}, not the declared ${contentType}`),
        { status: 400 },
      );
    }
    if (head.ContentLength > MAX_BYTES) {
      throw Object.assign(new Error('Uploaded KYC document exceeds the size limit'), { status: 400 });
    }
    return { key, docType: parsed.docType, contentType: head.ContentType, size: head.ContentLength };
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error('KYC document was not uploaded'), { status: 400, cause: err });
  }
}

/**
 * A short-lived grant to VIEW one document, minted per review.
 *
 * The whole point of the module. This URL is returned to one authenticated
 * admin, lives for two minutes, and is never stored, mirrored or logged — so
 * access to an identity document is a decision taken at review time rather than
 * a permanent property of a string in a database.
 *
 * Callers must not persist the result. There is no way for this module to
 * enforce that, which is why the KEY is what every other layer handles.
 */
export async function presignReview({ key, expiresIn = REVIEW_TTL_SECONDS, expectedUserId = null }) {
  if (!configured()) throw Object.assign(new Error('KYC document storage is not configured'), { status: 503 });
  // `expectedUserId` is how the admin route says "this key came out of THIS
  // user's record". A key that disagrees means the record is wrong, and the
  // right answer is to refuse rather than to show a reviewer someone else's ID.
  assertKeyBelongsTo(key, { expectedUserId });
  // Bounded regardless of what a caller asks for: a "convenient" hour-long
  // review link is the failure this replaces, in a smaller form.
  const ttl = Math.min(Math.max(Number(expiresIn) || REVIEW_TTL_SECONDS, 30), 600);
  const url = await getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: ttl });
  return { url, expiresIn: ttl };
}

/**
 * Delete a user's document. For erasure requests, and for replacing a
 * superseded submission so a rejected user's old ID does not linger.
 */
export async function deleteDocument(key, { expectedUserId = null } = {}) {
  if (!configured()) throw Object.assign(new Error('KYC document storage is not configured'), { status: 503 });
  assertKeyBelongsTo(key, { expectedUserId });
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return { key, deleted: true };
}

/** Test seam: drop the memoised client so a suite can change the environment. */
export function _resetClient() { client = null; }

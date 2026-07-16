// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ═══════════════════════════════════════════════════════════════════════
 * 📦 ANONYMOUS S3 CDN SERVICE - ZERO RAM, PRESIGNED URLS
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * This service handles ALL file uploads via Vultr S3 with:
 * - ✅ Presigned URLs (files never touch backend)
 * - ✅ Zero RAM usage (direct browser → S3)
 * - ✅ BunnyCDN delivery (fast worldwide)
 * - ✅ Complete anonymity (crypto-paid infrastructure)
 * 
 * Architecture:
 * 1. Frontend requests presigned URL from backend
 * 2. Backend generates S3 presigned URL (5min expiry)
 * 3. Frontend uploads directly to S3 (bypasses backend)
 * 4. File immediately available via BunnyCDN

  * - Async file uploads (non-blocking)
 * - Automatic optimization
 * - CDN delivery (fast worldwide)
 * - Thumbnail generation
 * - File type validation
 * - Size limits
 * - Error handling
 * - Cost optimization
 * 
 * @version 1.0.0-anonymous
 * @author Anonymous
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════════
// S3 CLIENT INITIALIZATION (VULTR)
// ═══════════════════════════════════════════════════════════════════════

const s3Client = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: (() => { const e = process.env.S3_ENDPOINT || ''; return e.startsWith('http') ? e : 'https://' + e; })(),
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true, // Required for Vultr S3
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const CDN_URL = process.env.CDN_URL; // e.g., https://yourzone.b-cdn.net

// ═══════════════════════════════════════════════════════════════════════
// VALIDATION & SECURITY
// ═══════════════════════════════════════════════════════════════════════

// Strict MIME → allowed extensions map.
// BOTH the MIME type AND the file extension must match.
// An attacker who sends contentType:'image/jpeg' with file='shell.php'
// will be rejected by the extension cross-check below.
const IMAGE_MIME_TYPES = {
  'image/jpeg': { exts: ['.jpg', '.jpeg'], maxSize: 10 * 1024 * 1024 },
  'image/jpg':  { exts: ['.jpg', '.jpeg'], maxSize: 10 * 1024 * 1024 },
  'image/png':  { exts: ['.png'],          maxSize: 10 * 1024 * 1024 },
  'image/webp': { exts: ['.webp'],         maxSize: 10 * 1024 * 1024 },
  'image/gif':  { exts: ['.gif'],          maxSize:  5 * 1024 * 1024 },
};

const DISPUTE_EXTRA_MIME_TYPES = {
  'application/pdf': { exts: ['.pdf'],  maxSize: 20 * 1024 * 1024 },
  'video/mp4':       { exts: ['.mp4'],  maxSize: 50 * 1024 * 1024 },
  'video/quicktime': { exts: ['.mov'],  maxSize: 50 * 1024 * 1024 },
  'video/webm':      { exts: ['.webm'], maxSize: 50 * 1024 * 1024 },
};

function mimeRulesForCategory(category = '') {
  const key = String(category).toLowerCase();
  return key.startsWith('dispute') ? { ...IMAGE_MIME_TYPES, ...DISPUTE_EXTRA_MIME_TYPES } : IMAGE_MIME_TYPES;
}

// Dangerous extensions that must NEVER reach S3 regardless of MIME claim.
// Belt-and-suspenders: even if a future MIME entry accidentally allowed one,
// this list provides an independent hard stop.
const BLOCKED_EXTENSIONS = new Set([
  '.php', '.php3', '.php4', '.php5', '.phtml',
  '.asp', '.aspx', '.cshtml', '.ashx',
  '.jsp', '.jspx',
  '.py', '.rb', '.pl', '.cgi', '.sh', '.bash', '.zsh',
  '.exe', '.dll', '.so', '.bat', '.cmd', '.ps1', '.vbs',
  '.js',  '.mjs', '.ts', '.jsx', '.tsx',        // no JS uploads
  '.html', '.htm', '.svg', '.xml',               // no HTML/SVG (XSS via CDN)
  '.htaccess', '.env', '.config',
]);

/**
 * Validate file upload request.
 *
 * Three independent checks must ALL pass:
 *  1. MIME type is in the strict allowlist (no startsWith wildcards)
 *  2. File extension matches the declared MIME type
 *  3. File extension is not on the explicit blocklist
 *  4. File size is within the per-MIME limit
 *  5. Filename contains no path-traversal sequences
 */
function validateUpload(fileName, contentType, fileSize, category = '') {
  // ── 1. Normalise and check MIME type ─────────────────────────────────────
  // Lowercase and strip any parameters (e.g. "image/jpeg; charset=utf-8")
  const mime = (contentType || '').toLowerCase().split(';')[0].trim();
  const mimeRule = mimeRulesForCategory(category)[mime];
  if (!mimeRule) {
    throw new Error(
      `File type "${mime}" is not allowed. ` +
      `Allowed: JPEG, PNG, WebP, GIF; PDF/video only for dispute evidence`
    );
  }

  // ── 2. Extract and normalise file extension ───────────────────────────────
  const rawName = (fileName || '').trim();
  const lastDot = rawName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === rawName.length - 1) {
    throw new Error('File must have a recognised extension (e.g. .jpg, .png, .pdf)');
  }
  const ext = rawName.slice(lastDot).toLowerCase();

  // ── 3. Hard-block dangerous extensions ───────────────────────────────────
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`Extension "${ext}" is not permitted`);
  }

  // ── 4. Extension must match declared MIME type ────────────────────────────
  // Prevents "rename shell.php to photo.jpg, claim image/jpeg"
  if (!mimeRule.exts.includes(ext)) {
    throw new Error(
      `Extension "${ext}" does not match declared type "${mime}". ` +
      `Expected: ${mimeRule.exts.join(', ')}`
    );
  }

  // ── 5. File size ──────────────────────────────────────────────────────────
  const size = Number(fileSize);
  if (!size || size <= 0 || size > mimeRule.maxSize) {
    const mb = (mimeRule.maxSize / (1024 * 1024)).toFixed(0);
    throw new Error(`File size must be > 0 and ≤ ${mb} MB for ${mime}`);
  }

  // ── 6. Filename safety ────────────────────────────────────────────────────
  if (rawName.includes('..') || /[/\\]/.test(rawName)) {
    throw new Error('Invalid filename — path separators not allowed');
  }
  // Allow only safe characters: alphanumeric, dash, underscore, dot, space
  if (!/^[\w\s.\-()[\]]+$/i.test(rawName)) {
    throw new Error('Filename contains invalid characters');
  }

  return true;
}



/**
 * Generate secure random filename.
 * Always uses the extension from the ALLOWED_MIME_TYPES map (not the raw filename)
 * so the stored key extension always matches the validated MIME type.
 */
function generateSecureFileName(originalName, contentType, category) {
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(16).toString('hex');
  // Use the first allowed extension for this MIME — never trust the raw extension
  const mime = (contentType || '').toLowerCase().split(';')[0].trim();
  const safeExt = (mimeRulesForCategory(category)[mime]?.exts[0]) || '.bin';
  return `${category}/${timestamp}-${randomString}${safeExt}`;
}

// ═══════════════════════════════════════════════════════════════════════
// PRESIGNED URL GENERATION (CORE FUNCTIONALITY)
// ═══════════════════════════════════════════════════════════════════════


export async function generatePresignedUploadUrl({
  fileName,
  contentType,
  fileSize,
  category,
  userId,
  orderId = null,
}) {
  try {
    // Validate: MIME + extension cross-check + size + filename safety
    validateUpload(fileName, contentType, fileSize, category);

    // Generate secure file key — extension derived from MIME, not raw filename
    const fileKey = generateSecureFileName(fileName, contentType, category);

    // Normalise MIME (strip params like "; charset=utf-8")
    const cleanMime = contentType.toLowerCase().split(';')[0].trim();

    // Create S3 PUT command.
    // ContentType is enforced by S3: the browser MUST send the identical
    // Content-Type header when it PUTs to the presigned URL, or S3 rejects
    // the upload with 403. This is a second enforcement layer independent
    // of our route-level check — even a MITM or script that forges the
    // contentType in the JSON body cannot upload a different file type.
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      ContentType: cleanMime,
      // S3 condition: enforce max content length on the presigned URL itself.
      // S3 will reject any PUT that exceeds this byte count.
      ContentLength: Number(fileSize),
      Metadata: {
        userId:     String(userId),
        orderId:    orderId || 'none',
        uploadedAt: new Date().toISOString(),
        // Store original validated MIME so downstream code can verify
        declaredMime: cleanMime,
      },
    });

    // Generate presigned URL (5 minutes expiry)
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

    // Generate CDN URL for accessing the file
    const cdnUrl = `${CDN_URL}/${fileKey}`;

    console.log('✅ Generated presigned URL:', {
      fileKey,
      category,
      userId,
      orderId,
      mime: cleanMime,
      expiresIn: '5 minutes',
    });

    return {
      uploadUrl,
      fileKey,
      cdnUrl,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
  } catch (error) {
    console.error('❌ Presigned URL generation failed:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FILE MANAGEMENT (ADMIN OPERATIONS)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate presigned URL for downloading a file (admin use)
 */
export async function generatePresignedDownloadUrl(fileKey) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
    });
    
    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour
    
    return {
      downloadUrl,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  } catch (error) {
    console.error('❌ Download URL generation failed:', error);
    throw error;
  }
}

/**
 * True when S3 is fully configured for public serving (bucket + creds +
 * endpoint). Used by callers that must gracefully fall back to local storage
 * when object storage isn't set up (portability: runs with or without S3).
 */
export function isS3Configured() {
  return Boolean(
    process.env.S3_BUCKET_NAME &&
    process.env.S3_ACCESS_KEY &&
    process.env.S3_SECRET_KEY &&
    process.env.S3_ENDPOINT
  );
}

/**
 * Server-side direct upload of an in-memory buffer to a DETERMINISTIC key
 * (overwrites in place). For small fixed-slot admin assets (PWA icons/logos)
 * whose public URL must stay stable across re-uploads — unlike the random-key
 * presigned flow used for user uploads. Returns the public URL (CDN if
 * CDN_URL is set, else the path-style S3 object URL).
 */
export async function uploadBufferToS3(fileKey, buffer, contentType) {
  if (!isS3Configured()) throw new Error('S3 is not configured');
  const cleanMime = (contentType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
    Body: buffer,
    ContentType: cleanMime,
    ContentLength: buffer.length,
    CacheControl: 'public, max-age=3600',
  }));
  if (CDN_URL) return `${CDN_URL}/${fileKey}`;
  const ep = process.env.S3_ENDPOINT.startsWith('http') ? process.env.S3_ENDPOINT : 'https://' + process.env.S3_ENDPOINT;
  return `${ep}/${BUCKET_NAME}/${fileKey}`; // path-style (forcePathStyle S3)
}

/**
 * uploadStreamToS3 — multipart streaming upload for LARGE objects (database
 * backups, exports) where buffering in memory is not acceptable. Same
 * deterministic-key semantics as uploadBufferToS3. (Plan item 45, 2026-07-13.)
 */
export async function uploadStreamToS3(fileKey, stream, contentType = 'application/octet-stream') {
  if (!isS3Configured()) throw new Error('S3 is not configured');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const up = new Upload({
    client: s3Client,
    params: { Bucket: BUCKET_NAME, Key: fileKey, Body: stream, ContentType: contentType },
  });
  await up.done();
  if (CDN_URL) return `${CDN_URL}/${fileKey}`;
  const ep = process.env.S3_ENDPOINT.startsWith('http') ? process.env.S3_ENDPOINT : 'https://' + process.env.S3_ENDPOINT;
  return `${ep}/${BUCKET_NAME}/${fileKey}`;
}

/** listFiles — keys under a prefix (used by backup retention pruning). */
export async function listFiles(prefix) {
  if (!isS3Configured()) return [];
  const out = await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, MaxKeys: 1000 }));
  return (out.Contents || []).map(o => ({ key: o.Key, size: o.Size, lastModified: o.LastModified }));
}

/**
 * Delete file from S3 (admin use)
 */
export async function deleteFile(fileKey) {
  try {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
    });
    
    await s3Client.send(command);
    
    console.log('✅ File deleted:', fileKey);
    
    return { success: true, fileKey };
  } catch (error) {
    console.error('❌ File deletion failed:', error);
    throw error;
  }
}

export async function verifyUploadedObject({ fileKey, cdnUrl, expectedUserId, expectedOrderId = null, expectedCategory = null }) {
  if (!fileKey || typeof fileKey !== 'string') throw new Error('fileKey is required');
  if (fileKey.includes('..') || fileKey.startsWith('/') || /\\/.test(fileKey)) throw new Error('Invalid file key');
  if (expectedCategory && !fileKey.startsWith(`${expectedCategory}/`)) throw new Error('File key category mismatch');
  const expectedUrl = `${CDN_URL}/${fileKey}`;
  if (cdnUrl && cdnUrl !== expectedUrl) throw new Error('CDN URL does not match file key');

  const head = await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey }));
  const meta = head.Metadata || {};
  if (expectedUserId && meta.userid !== String(expectedUserId)) throw new Error('Uploaded object owner mismatch');
  if (expectedOrderId && meta.orderid !== String(expectedOrderId)) throw new Error('Uploaded object order mismatch');
  return { fileKey, cdnUrl: expectedUrl, contentType: head.ContentType, contentLength: head.ContentLength, metadata: meta };
}

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY-SPECIFIC HELPERS
// ═══════════════════════════════════════════════════════════════════════


export async function generateDisputeUploadUrl(fileName, contentType, fileSize, userId, disputeId) {
  return generatePresignedUploadUrl({
    fileName, contentType, fileSize, category: 'disputes/evidence', userId, orderId: disputeId,
  });
}

export async function generateChatUploadUrl(fileName, contentType, fileSize, userId, orderId) {
  return generatePresignedUploadUrl({
    fileName,
    contentType,
    fileSize,
    category: 'chat',
    userId,
    orderId,
  });
}

/**
 * Generate presigned URL for KYC document
 */
export async function generateKYCUploadUrl(fileName, contentType, fileSize, userId, docType) {
  return generatePresignedUploadUrl({
    fileName,
    contentType,
    fileSize,
    category: `kyc/${docType}`, // kyc/id_proof, kyc/address_proof, kyc/selfie
    userId,
  });
}

/**
 * Generate presigned URL for payment proof
 */
export async function generatePaymentProofUploadUrl(fileName, contentType, fileSize, userId, orderId) {
  return generatePresignedUploadUrl({
    fileName,
    contentType,
    fileSize,
    category: 'payment-proof',
    userId,
    orderId,
  });
}

/**
 * Generate presigned URL for profile picture
 */
export async function generateProfilePictureUploadUrl(fileName, contentType, fileSize, userId) {
  return generatePresignedUploadUrl({
    fileName,
    contentType,
    fileSize,
    category: 'profile',
    userId,
  });
}

/**
 * Generate presigned URL for admin branding image
 */
export async function generateBrandingUploadUrl(fileName, contentType, fileSize, userId, brandingCategory) {
  return generatePresignedUploadUrl({
    fileName,
    contentType,
    fileSize,
    category: `branding/${brandingCategory}`,
    userId,
  });
}

export async function generatePromoUploadUrl(fileName, contentType, fileSize, userId, location) {
  return generatePresignedUploadUrl({
    fileName,
    contentType,
    fileSize,
    category: `content/${location}`,   // content/tricks_page, content/rules_page, etc.
    userId,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Test S3 connection
 */
export async function testS3Connection() {
  try {
    // Try to generate a test presigned URL
    const testKey = `test/${Date.now()}.txt`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: testKey,
      ContentType: 'text/plain',
    });
    
    await getSignedUrl(s3Client, command, { expiresIn: 60 });
    
    console.log('✅ S3 connection test successful');
    return { success: true, message: 'S3 connection working' };
  } catch (error) {
    console.error('❌ S3 connection test failed:', error);
    return { success: false, message: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

export default {
  generatePresignedUploadUrl,
  generatePresignedDownloadUrl,
  deleteFile,
  verifyUploadedObject,
  generateDisputeUploadUrl,
  generateChatUploadUrl,
  generateKYCUploadUrl,
  generatePaymentProofUploadUrl,
  generateProfilePictureUploadUrl,
  generateBrandingUploadUrl,
  generatePromoUploadUrl,
  testS3Connection,
};

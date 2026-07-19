// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// STATUS: PENDING — do not run until production has AADHAAR_HMAC_SECRET configured and the unique Aadhaar index is deployed.
/**
 * Replaces legacy SHA-256 Aadhaar hashes using the plaintext KYC value with
 * HMAC-SHA-256 hashes in bounded batches. Invalid source values and duplicate
 * hash conflicts are marked for review and excluded from future batches. Run
 * repeatedly until the summary reports no migrated or skipped records:
 *   node backend/scripts/migrate-aadhaar-hashes.js [--limit=500]
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { hashAadhaar } from '../domains/identity/aadhaarHash.util.js';
import '../models/index.js';

dotenv.config();

function normalizeAadhaar(raw) {
  const normalized = String(raw || '').replace(/[\s-]/g, '');
  return /^\d{12}$/.test(normalized) ? normalized : null;
}

function maskAadhaar(normalized) {
  return `XXXX-XXXX-${normalized.slice(-4)}`;
}

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be configured');
if (!process.env.AADHAAR_HMAC_SECRET) throw new Error('AADHAAR_HMAC_SECRET must be configured');

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const rawLimit = limitArg?.split('=')[1];
const parsedLimit = rawLimit === undefined || rawLimit === '' ? NaN : Number(rawLimit);
const batchLimit = Number.isFinite(parsedLimit)
  ? Math.min(Math.max(parsedLimit, 1), 5000)
  : 500;

await mongoose.connect(process.env.MONGODB_URI);
try {
  const User = mongoose.model('User');
  const unhashedFilter = { $or: [{ aadhaarHash: { $exists: false } }, { aadhaarHash: null }] };
  const users = await User.find({
    'kycData.aadhaarNumber': { $exists: true, $ne: '' },
    'aadhaarHashMigration.status': { $nin: ['INVALID_AADHAAR', 'DUPLICATE_HASH'] },
    ...unhashedFilter
  })
    .select('_id kycData.aadhaarNumber aadhaarHash')
    .limit(batchLimit);
  let migrated = 0;
  let skipped = 0;

  for (const user of users) {
    const originalAadhaar = user.kycData?.aadhaarNumber;
    const normalizedAadhaar = normalizeAadhaar(originalAadhaar);
    const conditionalFilter = {
      _id: user._id,
      'kycData.aadhaarNumber': originalAadhaar,
      ...unhashedFilter
    };
    const markForReview = (status, reason) => User.updateOne(
      conditionalFilter,
      { $set: { aadhaarHashMigration: { status, reason, reviewedAt: new Date() } } }
    );

    const aadhaarHash = hashAadhaar(normalizedAadhaar);
    if (!aadhaarHash) {
      const result = await markForReview('INVALID_AADHAAR', 'Legacy Aadhaar value is not recoverable as 12 digits.');
      if (result.matchedCount > 0) skipped += 1;
      continue;
    }
    if (user.aadhaarHash === aadhaarHash) continue;
    try {
      const result = await User.updateOne(
        conditionalFilter,
        { $set: { aadhaarHash, 'kycData.aadhaarNumber': maskAadhaar(normalizedAadhaar) } }
      );
      if (result.matchedCount > 0) migrated += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const result = await markForReview('DUPLICATE_HASH', 'Aadhaar hash conflicts with another user.');
      if (result.matchedCount > 0) skipped += 1;
      console.warn(`Marked ${user._id} for review: Aadhaar hash conflicts with another user.`);
    }
  }
  console.log(`Aadhaar HMAC migration batch complete: ${migrated} migrated, ${skipped} skipped, limit ${batchLimit}.`);
} finally {
  await mongoose.disconnect();
}

// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// STATUS: PENDING — do not run until production has AADHAAR_HMAC_SECRET configured and the unique Aadhaar index is deployed.
/**
 * Replaces legacy SHA-256 Aadhaar hashes using the plaintext KYC value with
 * HMAC-SHA-256 hashes in bounded batches. Run repeatedly until the summary
 * reports no migrated or skipped records:
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
const batchLimit = Math.min(Math.max(Number(limitArg?.split('=')[1]) || 500, 1), 5000);

await mongoose.connect(process.env.MONGODB_URI);
try {
  const User = mongoose.model('User');
  const users = await User.find({
    'kycData.aadhaarNumber': { $exists: true, $ne: '' },
    $or: [{ aadhaarHash: { $exists: false } }, { aadhaarHash: null }]
  })
    .select('_id kycData.aadhaarNumber aadhaarHash')
    .limit(batchLimit);
  let migrated = 0;
  let skipped = 0;

  for (const user of users) {
    const normalizedAadhaar = normalizeAadhaar(user.kycData?.aadhaarNumber);
    const aadhaarHash = hashAadhaar(normalizedAadhaar);
    if (!aadhaarHash) {
      skipped += 1;
      continue;
    }
    if (user.aadhaarHash === aadhaarHash) continue;
    try {
      await User.updateOne(
        { _id: user._id },
        { $set: { aadhaarHash, 'kycData.aadhaarNumber': maskAadhaar(normalizedAadhaar) } }
      );
      migrated += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      skipped += 1;
      console.warn(`Skipped ${user._id}: Aadhaar hash conflicts with another user.`);
    }
  }
  console.log(`Aadhaar HMAC migration batch complete: ${migrated} migrated, ${skipped} skipped, limit ${batchLimit}.`);
} finally {
  await mongoose.disconnect();
}

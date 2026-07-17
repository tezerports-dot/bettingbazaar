// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// STATUS: PENDING — do not run until production has AADHAAR_HMAC_SECRET configured and the unique Aadhaar index is deployed.
/**
 * Replaces legacy SHA-256 Aadhaar hashes using the plaintext KYC value with
 * HMAC-SHA-256 hashes. Run once per environment: node backend/scripts/migrate-aadhaar-hashes.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { hashAadhaar } from '../domains/identity/aadhaarHash.util.js';
import '../models/index.js';

dotenv.config();

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be configured');
if (!process.env.AADHAAR_HMAC_SECRET) throw new Error('AADHAAR_HMAC_SECRET must be configured');

await mongoose.connect(process.env.MONGODB_URI);
try {
  const User = mongoose.model('User');
  const users = User.find({ 'kycData.aadhaarNumber': { $exists: true, $ne: '' } })
    .select('_id kycData.aadhaarNumber aadhaarHash').cursor();
  let migrated = 0;
  let skipped = 0;

  for await (const user of users) {
    const aadhaarHash = hashAadhaar(user.kycData?.aadhaarNumber);
    if (!aadhaarHash) {
      skipped += 1;
      continue;
    }
    if (user.aadhaarHash === aadhaarHash) continue;
    try {
      await User.updateOne({ _id: user._id }, { $set: { aadhaarHash } });
      migrated += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      skipped += 1;
      console.warn(`Skipped ${user._id}: Aadhaar hash conflicts with another user.`);
    }
  }
  console.log(`Aadhaar HMAC migration complete: ${migrated} migrated, ${skipped} skipped.`);
} finally {
  await mongoose.disconnect();
}

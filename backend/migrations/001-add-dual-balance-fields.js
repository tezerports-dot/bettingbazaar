// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * MIGRATION STATUS: APPLIED — do not re-run.
 * H-08 / GOVERNANCE: applied migrations must be deleted after all environments confirm.
 * This file is kept only for audit trail. Delete it once confirmed in production.
 */
/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📦 MIGRATION 001: Add depositBalance + winningsBalance to existing users
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Infrastructure Issue #4 (from assessment):
 * Bug #38 identified missing depositBalance/winningsBalance fields in User model.
 * Just updating the code is NOT enough for existing users in MongoDB — their
 * documents won't have these fields and will return undefined/NaN in the UI.
 * 
 * This script initialises the fields for all users who don't have them yet,
 * by converting their existing walletBalance into depositBalance.
 * 
 * Run ONCE before deploying code fixes:
 *   node backend/migrations/001-add-dual-balance-fields.js
 * 
 * Safe to re-run: uses $exists check, won't overwrite existing values.
 * ════════════════════════════════════════════════════════════════════════════
 */
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set. Run with correct .env file.');
  process.exit(1);
}

async function runMigration() {
  console.log('🔗 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected.');

  const users = mongoose.connection.db.collection('users');

  const missingBoth = await users.countDocuments({
    $or: [
      { depositBalance:  { $exists: false } },
      { winningsBalance: { $exists: false } }
    ]
  });

  console.log(`\n📊 Users missing dual-balance fields: ${missingBoth}`);
  if (missingBoth === 0) {
    console.log('✅ All users already have dual-balance fields. Migration not needed.');
    await mongoose.disconnect();
    return;
  }

  // Seed depositBalance from existing walletBalance (net of locked)
  const step1 = await users.updateMany(
    { depositBalance: { $exists: false } },
    [{ $set: { depositBalance: { $max: [{ $subtract: [{ $ifNull: ['$walletBalance', 0] }, { $ifNull: ['$lockedBalance', 0] }] }, 0] } } }]
  );
  console.log(`✅ Step 1: depositBalance set for ${step1.modifiedCount} users from walletBalance`);

  const step2 = await users.updateMany(
    { winningsBalance: { $exists: false } },
    { $set: { winningsBalance: 0 } }
  );
  console.log(`✅ Step 2: winningsBalance=0 for ${step2.modifiedCount} users`);

  const step3 = await users.updateMany(
    { lockedDepositAmount: { $exists: false } },
    { $set: { lockedDepositAmount: 0, lockedWinningsAmount: 0 } }
  );
  console.log(`✅ Step 3: lockedDepositAmount/lockedWinningsAmount=0 for ${step3.modifiedCount} users`);

  const remaining = await users.countDocuments({
    $or: [{ depositBalance: { $exists: false } }, { winningsBalance: { $exists: false } }]
  });

  if (remaining === 0) {
    console.log('\n🎉 Migration 001 complete! All users have dual-balance fields.');
  } else {
    console.error(`\n❌ ${remaining} users still missing fields.`);
    process.exit(1);
  }

  await mongoose.disconnect();
}

runMigration().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});

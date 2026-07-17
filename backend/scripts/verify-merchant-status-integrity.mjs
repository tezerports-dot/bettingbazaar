#!/usr/bin/env node
/**
 * audit/verify-merchant-status-integrity.mjs
 *
 * READ-ONLY. Makes zero writes. Verifies whether there are merchants approved
 * (merchantApprovalStatus: 'APPROVED') but never activated (status !== 'ACTIVE')?
 *
 * That state is what would cause auto-assignment (merchantScoring.service.js) to
 * silently skip an otherwise-eligible merchant.
 *
 * Usage (from repo root, against whatever MONGODB_URI you point it at):
 *   MONGODB_URI="<railway-prod-uri>" node audit/verify-merchant-status-integrity.mjs
 *
 * Exit code 0 + "OK" if clean. Exit code 1 + a printed list if mismatches found —
 * the printed list is everything needed to write a one-line corrective update,
 * which this script deliberately does NOT do for you.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI not set. Point this at the environment you want to verify.');
  process.exit(1);
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'bettingbazaar' });
  console.log(`Connected to: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  const Merchant = mongoose.connection.collection('merchants');

  // Case A: approved but never activated (the F1 hypothesis)
  const approvedNotActive = await Merchant.find({
    merchantApprovalStatus: 'APPROVED',
    status: { $ne: 'ACTIVE' },
  }).project({ _id: 1, username: 1, status: 1, merchantApprovalStatus: 1, createdAt: 1 }).toArray();

  // Case B: active but never approved (the inverse — shouldn't be possible, worth knowing if it is)
  const activeNotApproved = await Merchant.find({
    status: 'ACTIVE',
    merchantApprovalStatus: { $ne: 'APPROVED' },
  }).project({ _id: 1, username: 1, status: 1, merchantApprovalStatus: 1, createdAt: 1 }).toArray();

  console.log(`Approved-but-not-ACTIVE merchants: ${approvedNotActive.length}`);
  if (approvedNotActive.length) {
    console.table(approvedNotActive.map(m => ({
      id: m._id.toString(), username: m.username, status: m.status,
      approval: m.merchantApprovalStatus, createdAt: m.createdAt,
    })));
  }

  console.log(`\nACTIVE-but-not-approved merchants: ${activeNotApproved.length}`);
  if (activeNotApproved.length) {
    console.table(activeNotApproved.map(m => ({
      id: m._id.toString(), username: m.username, status: m.status,
      approval: m.merchantApprovalStatus, createdAt: m.createdAt,
    })));
  }

  const totalMismatch = approvedNotActive.length + activeNotApproved.length;
  await mongoose.disconnect();

  if (totalMismatch === 0) {
    console.log('\nOK — no mismatches. F1 is closed. backend/migrations/002-fix-everything.js is safe to delete.');
    process.exit(0);
  } else {
    console.log(`\n${totalMismatch} mismatch(es) found. This is a data issue, not a code issue — `
      + 're-run backend/migrations/002-fix-everything.js, or share this output and I\'ll write a targeted fix.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});

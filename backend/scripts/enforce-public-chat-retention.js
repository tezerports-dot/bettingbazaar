#!/usr/bin/env node
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// STATUS: PENDING — do not run until the target environment is ready. Delete after confirmed application everywhere.
/**
 * Enforce the PublicChatMsg 5-hour TTL for existing records.
 *
 * This intentionally updates only PublicChatMsg.expiresAt. SupportMsg records are
 * modeled separately and keep their independent support-ticket retention.
 */
import mongoose from 'mongoose';
import { PublicChatMsg, PUBLIC_CHAT_RETENTION_MS } from '../models/social.model.js';

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) throw new Error('Set MONGO_URI or MONGODB_URI before running this migration.');

await mongoose.connect(mongoUri);

try {
  const now = new Date();
  const retentionFloor = new Date(now.getTime() - PUBLIC_CHAT_RETENTION_MS);
  const result = await PublicChatMsg.updateMany(
    {
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: null },
        { expiresAt: { $gt: now } },
      ],
    },
    [
      {
        $set: {
          expiresAt: {
            $min: [
              { $ifNull: ['$expiresAt', now] },
              { $dateAdd: { startDate: { $max: ['$createdAt', retentionFloor] }, unit: 'millisecond', amount: PUBLIC_CHAT_RETENTION_MS } },
            ],
          },
        },
      },
    ]
  );

  console.log(`PublicChatMsg retention enforced: matched ${result.matchedCount}, modified ${result.modifiedCount}.`);
} finally {
  await mongoose.disconnect();
}

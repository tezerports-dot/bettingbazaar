// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * UTRRegistry — Global UTR uniqueness registry.
 * Section 9 of the Migration Patch Specification.
 *
 * One UTR = one order. Unique index enforces this atomically at the storage layer.
 * status lifecycle: ACTIVE → RELEASED (on order complete/cancel) | FRAUD (admin-flagged).
 */
import mongoose from 'mongoose';

const utrRegistrySchema = new mongoose.Schema({
  utr: {
    type: String, required: true,
    uppercase: true, trim: true,
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'PaymentOrder',
    required: true, unique: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'User',
    required: true,
  },
  amount:       { type: Number, required: true },
  registeredAt: { type: Date, default: Date.now, index: true },
  status: {
    type: String,
    enum: ['ACTIVE', 'RELEASED', 'FRAUD'],
    default: 'ACTIVE',
  },
});

// Global UTR uniqueness — two concurrent inserts: exactly one wins, other gets code 11000
utrRegistrySchema.index({ utr: 1 }, { unique: true });
// Per-user fraud pattern lookup
utrRegistrySchema.index({ userId: 1, registeredAt: -1 });

export const UTRRegistry = mongoose.model('UTRRegistry', utrRegistrySchema);
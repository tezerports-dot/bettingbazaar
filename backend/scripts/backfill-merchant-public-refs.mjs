import crypto from 'crypto';
import mongoose from 'mongoose';
import '../domains/merchant/merchant.model.js';

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) throw new Error('Set MONGO_URI or MONGODB_URI before running this migration.');

function generateMerchantPublicRef() {
  return `M${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

await mongoose.connect(mongoUri);
const Merchant = mongoose.model('Merchant');

let updated = 0;
const cursor = Merchant.find({ $or: [{ publicRef: { $exists: false } }, { publicRef: '' }, { publicRef: null }] }).cursor();
for await (const merchant of cursor) {
  for (;;) {
    try {
      const publicRef = generateMerchantPublicRef();
      await Merchant.collection.updateOne({ _id: merchant._id }, { $set: { publicRef } });
      updated += 1;
      break;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
}

console.log(`Backfilled ${updated} merchant public references.`);
await mongoose.disconnect();

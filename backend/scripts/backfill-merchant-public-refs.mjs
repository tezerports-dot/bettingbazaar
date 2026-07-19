// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import { generateMerchantPublicRef } from '../domains/merchant/merchant.model.js';

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) throw new Error('Set MONGO_URI or MONGODB_URI before running this migration.');

const publicRefMissingQuery = { $or: [{ publicRef: { $exists: false } }, { publicRef: '' }, { publicRef: null }] };

await mongoose.connect(mongoUri);
const Merchant = mongoose.model('Merchant');

await Merchant.collection.dropIndex('publicRef_1').catch((err) => {
  if (err?.codeName !== 'IndexNotFound') throw err;
});
await Merchant.collection.createIndex(
  { publicRef: 1 },
  { unique: true, name: 'publicRef_1', partialFilterExpression: { publicRef: { $exists: true, $type: 'string' } } }
);

let updated = 0;
const cursor = Merchant.find(publicRefMissingQuery).cursor();
for await (const merchant of cursor) {
  for (;;) {
    try {
      const publicRef = generateMerchantPublicRef();
      const result = await Merchant.collection.updateOne({ _id: merchant._id, ...publicRefMissingQuery }, { $set: { publicRef } });
      if (result.modifiedCount === 1) updated += 1;
      break;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
}

await Merchant.collection.dropIndex('publicRef_1').catch((err) => {
  if (err?.codeName !== 'IndexNotFound') throw err;
});
await Merchant.collection.createIndex({ publicRef: 1 }, { unique: true, name: 'publicRef_1' });

console.log(`Backfilled ${updated} merchant public references.`);
await mongoose.disconnect();

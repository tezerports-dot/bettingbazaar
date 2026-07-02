import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL);

const Merchant = mongoose.model('Merchant', new mongoose.Schema({}, { strict: false }), 'merchants');

const merchant = await Merchant.findOne({ mobile: '9376553059' }).lean();
console.log('=== Raw merchant doc ===');
console.log(JSON.stringify(merchant, null, 2));

console.log('\n=== Type checks ===');
console.log('isOnline:', merchant.isOnline, typeof merchant.isOnline);
console.log('merchantApprovalStatus:', merchant.merchantApprovalStatus, typeof merchant.merchantApprovalStatus);
console.log('acceptsDeposits:', merchant.acceptsDeposits, typeof merchant.acceptsDeposits);
console.log('tokenBalance:', merchant.tokenBalance, typeof merchant.tokenBalance);
console.log('activeOrderCount:', merchant.activeOrderCount, typeof merchant.activeOrderCount);
console.log('maxConcurrentOrders:', merchant.maxConcurrentOrders, typeof merchant.maxConcurrentOrders);

console.log('\n=== Running the EXACT selectBestMerchant query ===');
const baseQuery = {
  isOnline: true,
  merchantApprovalStatus: 'APPROVED',
  $or: [
    { $expr: { $lt: ['$activeOrderCount', '$maxConcurrentOrders'] } },
    { activeOrderCount: { $exists: false } },
    { activeOrderCount: null },
  ],
  acceptsDeposits: true,
  tokenBalance: { $gte: 500 },
};
const results = await Merchant.find(baseQuery).lean();
console.log('Matched count:', results.length);
console.log('Matched mobiles:', results.map(r => r.mobile));

console.log('\n=== Testing each condition in isolation ===');
console.log('isOnline:true matches:', (await Merchant.find({ isOnline: true }).lean()).map(m=>m.mobile));
console.log('merchantApprovalStatus:APPROVED matches:', (await Merchant.find({ merchantApprovalStatus: 'APPROVED' }).lean()).map(m=>m.mobile));
console.log('acceptsDeposits:true matches:', (await Merchant.find({ acceptsDeposits: true }).lean()).map(m=>m.mobile));
console.log('tokenBalance>=500 matches:', (await Merchant.find({ tokenBalance: { $gte: 500 } }).lean()).map(m=>m.mobile));
console.log('$or activeOrderCount fallback matches:', (await Merchant.find({ $or: [
  { $expr: { $lt: ['$activeOrderCount', '$maxConcurrentOrders'] } },
  { activeOrderCount: { $exists: false } },
  { activeOrderCount: null },
] }).lean()).map(m=>m.mobile));

await mongoose.disconnect();

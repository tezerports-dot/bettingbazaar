import mongoose from "mongoose";
await import("./backend/models/merchant.model.js");

await mongoose.connect(process.env.MONGODB_URI);

const Merchant = mongoose.model("Merchant");

const docs = await Merchant.find({}, {
  name:1,
  username:1,
  activeOrderCount:1,
  maxConcurrentOrders:1,
  successRate:1,
  avgResponseMinutes:1,
  disputeRate:1,
  isOnline:1,
  merchantApprovalStatus:1,
  status:1,
  acceptsDeposits:1,
  acceptsWithdrawals:1,
  tokenBalance:1
}).lean();

console.log(JSON.stringify(docs,null,2));

await mongoose.disconnect();

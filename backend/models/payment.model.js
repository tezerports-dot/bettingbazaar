// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const frontendErrorReportSchema = new mongoose.Schema({
  message:   { type: String, required: true },
  stack:     { type: String },
  component: { type: String },
  url:       { type: String },
  panel:     { type: String, enum: ['user', 'merchant', 'unknown'], default: 'unknown' },
  ts:        { type: Date, default: Date.now, index: true },
}, { capped: { size: 5242880, max: 500 } });

export const FrontendErrorReport = mongoose.model('FrontendErrorReport', frontendErrorReportSchema);


// ===========================================================================
// ██████╗  █████╗ ██╗   ██╗███╗   ███╗███████╗███╗   ██╗████████╗
// ██╔══██╗██╔══██╗╚██╗ ██╔╝████╗ ████║██╔════╝████╗  ██║╚══██╔══╝
// ██████╔╝███████║ ╚████╔╝ ██╔████╔██║█████╗  ██╔██╗ ██║   ██║
// ██╔═══╝ ██╔══██║  ╚██╔╝  ██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║
// ██║     ██║  ██║   ██║   ██║ ╚═╝ ██║███████╗██║ ╚████║   ██║
//  NEW MODELS — Payments, Referral, Retention, Gamification
// ===========================================================================

// ---------------------------------------------------------------------------
// PAYMENT GATEWAY CONFIG

//                              'GATEWAY' (future: orders hit gateway API instead)
// ---------------------------------------------------------------------------
const paymentGatewayConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  
  activeMode: { type: String, enum: ['P2P', 'GATEWAY'], default: 'P2P' },
  p2pEnabled: { type: Boolean, default: true },

  // Gateway API config — only used when activeMode = 'GATEWAY'
  gatewayEnabled:       { type: Boolean, default: false },
  gatewayProvider:      { type: String, enum: ['EKQR','RAZORPAY','CASHFREE','PAYU','CUSTOM'], default: 'RAZORPAY' },
  gatewayApiKey:        { type: String, default: '' },
  gatewayApiSecret:     { type: String, default: '' },
  gatewayWebhookSecret: { type: String, default: '' },
  gatewayCallbackUrl:   { type: String, default: '' },
  gatewayMerchantId:    { type: String, default: '' },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: { type: Date, default: Date.now },
});
export const PaymentGatewayConfig = mongoose.model('PaymentGatewayConfig', paymentGatewayConfigSchema);

// ---------------------------------------------------------------------------
// REFERRAL — tracks invite-code tree and commission rates
// ---------------------------------------------------------------------------
const referralSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  inviteCode:  { type: String, required: true, unique: true, index: true },
  referredBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  level:       { type: Number, default: 0 },  // 0=root, 1=F1, 2=F2, 3=F3
  totalReferrals:  { type: Number, default: 0 },
  activeReferrals: { type: Number, default: 0 },
  totalEarned:     { type: Number, default: 0 },
  todayEarned:     { type: Number, default: 0 },
  lastEarnedDate:  { type: String },  // YYYY-MM-DD
  createdAt:   { type: Date, default: Date.now },
});


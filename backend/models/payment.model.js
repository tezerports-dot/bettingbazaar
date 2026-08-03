// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

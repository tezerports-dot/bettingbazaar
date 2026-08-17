// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import crypto   from 'crypto';
import mongoose from 'mongoose';

// New orders (and the model hook) sign with the CURRENT secret; verification
// ALSO accepts retained rotation secrets (ORDER_HMAC_PREVIOUS_SECRETS, comma-
// separated) so rotating ORDER_HMAC_SECRET never 403s in-flight orders signed
// under the old key. Mirrors the PASETO previous-public-keys and Aadhaar
// previous-secrets overlap, so every signing secret is now rotatable with zero
// user impact. Secrets are read at call time (like aadhaarHash.util.js).
const currentOrderSecret=()=>process.env.ORDER_HMAC_SECRET||process.env.JWT_SECRET;
const orderVerifySecrets=()=>[currentOrderSecret(),...(process.env.ORDER_HMAC_PREVIOUS_SECRETS||'').split(',').map(s=>s.trim()).filter(Boolean)].filter(Boolean);
const orderHmacWith=(secret,orderId)=>crypto.createHmac('sha256',secret).update(`order:${orderId}:v1`).digest('hex');

export function deriveOrderHmac(orderId){return orderHmacWith(currentOrderSecret(),orderId);}
// Timing-safe match against the current OR any retained rotation secret; every
// candidate is evaluated (no early return) so timing never reveals which matched.
export function verifyOrderHmac(orderId,stored){if(!stored)return false;const p=Buffer.from(String(stored));let ok=false;for(const s of orderVerifySecrets()){const e=Buffer.from(orderHmacWith(s,orderId));if(e.length===p.length&&crypto.timingSafeEqual(e,p))ok=true;}return ok;}

// Mongoose 9 (kareem 3) dropped the next() callback from middleware; this is a
// synchronous pre('save') hook, so it mutates the doc and returns.
export function setOrderHmacHook(){if(this.isNew||!this.orderHmac)this.orderHmac=deriveOrderHmac(this.orderId);}

export async function orderAccessGuard(req,res,next){
  try{
    const orderId=req.params.orderId||req.body?.orderId;
    if(!orderId)return res.status(400).json({success:false,message:'orderId required'});
    const PaymentOrder=mongoose.model('PaymentOrder');
    const order=await PaymentOrder.findOne({$or:[{orderId},{_id:mongoose.isValidObjectId(orderId)?new mongoose.Types.ObjectId(orderId):undefined}]}).select('+orderHmac userId merchantId status type').lean();
    if(!order)return res.status(404).json({success:false,message:'Order not found'});
    if(order.orderHmac&&!verifyOrderHmac(order.orderId,order.orderHmac)){console.error(`[orderAccessGuard] HMAC mismatch orderId=${order.orderId}`);return res.status(403).json({success:false,message:'Access denied'});}
    const uid=req.user?._id?.toString();
    const isBuyer=order.userId?.toString()===uid;
    const isMerchant=req.user?.isMerchant===true&&order.merchantId?.toString()===req.merchantId?.toString();
    const isAdmin=req.user?.isAdmin===true||req.user?.isSubAdmin===true;
    if(!isBuyer&&!isMerchant&&!isAdmin)return res.status(403).json({success:false,message:'Access denied'});
    req.p2pOrder=order;req.orderRole=isAdmin?'admin':isMerchant?'merchant':'buyer';next();
  }catch(e){res.status(500).json({success:false,message:'Access check failed'});}
}

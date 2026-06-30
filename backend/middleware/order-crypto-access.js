// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import crypto   from 'crypto';
import mongoose from 'mongoose';

const SECRET=process.env.ORDER_HMAC_SECRET||process.env.JWT_SECRET;

export function deriveOrderHmac(orderId){return crypto.createHmac('sha256',SECRET).update(`order:${orderId}:v1`).digest('hex');}
export function verifyOrderHmac(orderId,stored){if(!stored)return false;const e=Buffer.from(deriveOrderHmac(orderId)),p=Buffer.from(stored);return e.length===p.length&&crypto.timingSafeEqual(e,p);}

export async function setOrderHmacHook(next){if(this.isNew||!this.orderHmac)this.orderHmac=deriveOrderHmac(this.orderId);next();}

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

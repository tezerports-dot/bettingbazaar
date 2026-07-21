// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import { PaymentOrder } from '../types';
import { Clock, User, Phone, Copy } from 'lucide-react';
import { STATUS_LABELS } from '../constants';
import CountdownTimer from './CountdownTimer';
import toast from 'react-hot-toast';

interface OrderCardProps {
  order: PaymentOrder;
  onAccept:        (orderId: string) => void;
  onReject:        (orderId: string) => void;
  onViewDetails:   (order: PaymentOrder) => void;
  onConfirm?:      (orderId: string) => void;         // DEPOSIT PAID: release tokens
  onRejectPayment?: (orderId: string) => void;        // DEPOSIT PAID: dispute
  onMarkPayoutSent?: (orderId: string) => void;       // WITHDRAWAL PROCESSING: confirm sent
  onRaiseDispute?: (orderId: string) => void;         // Merchant raises dispute
}

const copyText = (text: string, label: string) => {
  navigator.clipboard.writeText(text).catch(() => {});
  toast.success(`${label} copied`);
};

const OrderCard: React.FC<OrderCardProps> = ({
  order, onAccept, onReject, onViewDetails,
  onConfirm, onRejectPayment, onMarkPayoutSent, onRaiseDispute,
}) => {
  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      ASSIGNED:   'bg-blue-100 text-blue-800 border-blue-300',
      PROCESSING: 'bg-yellow-100 text-yellow-800 border-yellow-300',
      PAID:       'bg-green-100 text-green-800 border-green-300',
      COMPLETED:  'bg-green-200 text-green-900 border-green-400',
      REJECTED:   'bg-red-100 text-red-800 border-red-300',
      DISPUTED:   'bg-orange-100 text-orange-800 border-orange-300',
      CANCELLED:  'bg-gray-100 text-gray-600 border-gray-300',
    };
    return colors[status] || 'bg-gray-100 text-gray-800 border-gray-300';
  };

  const fiatAmount   = order.fiatAmount   || (order as any).amount || 0;
  const tokenAmount  = order.tokenAmount  || (order as any).bbTokenAmount || 0;
  const merchantProfit = (order as any).merchantProfit || 0;
  const isDeposit    = order.type === 'DEPOSIT';
  const bank         = order.userBankDetails;
  const kyc          = order.userKycSnapshot;
  const userName     = typeof order.userId === 'object' ? (order.userId as any).username : (order as any).user?.username || 'Unknown User';
  const userPhone    = order.userPhone || (typeof order.userId === 'object' ? (order.userId as any).mobile : null) || 'N/A';

  return (
    <div className="bg-white rounded-lg shadow-lg p-5 hover:shadow-xl transition-all border border-gray-200">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 flex items-center space-x-2">
            <span>{isDeposit ? '⬇️ DEPOSIT' : '⬆️ WITHDRAWAL'}</span>
            <span className="text-gray-400">•</span>
            <span className="text-blue-600 text-sm font-mono">{(order as any).shortId || order.orderId?.slice(-8) || order._id?.slice(-8)}</span>
          </h3>
          <div className="flex items-center mt-1 space-x-3 text-sm text-gray-500">
            <span className="flex items-center"><User className="h-3.5 w-3.5 mr-1" />{userName}</span>
            {userPhone && userPhone !== 'N/A' && <span className="flex items-center"><Phone className="h-3.5 w-3.5 mr-1" />{userPhone}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end space-y-1.5">
          <span className={`px-3 py-1 rounded-full text-xs font-medium border ${getStatusColor(order.status)}`}>
            {STATUS_LABELS[order.status] || order.status}
          </span>
          {/* Countdown timer for ASSIGNED / PROCESSING */}
          {order.expiresAt && ['ASSIGNED', 'PROCESSING', 'PAID'].includes(order.status) && (
            <div className="flex items-center space-x-1">
              <Clock className="h-3.5 w-3.5 text-gray-400" />
              <CountdownTimer expiresAt={order.expiresAt} />
            </div>
          )}
        </div>
      </div>

      {/* ── Amounts ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500 mb-0.5">{isDeposit ? 'User pays' : 'You send'}</p>
          <p className="text-lg font-bold text-gray-900">₹{fiatAmount.toLocaleString('en-IN')}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500 mb-0.5">Tokens</p>
          <p className="text-lg font-bold text-gray-900">{tokenAmount.toLocaleString()}</p>
        </div>
      </div>

      {/* ══ STATUS-SPECIFIC CONTENT ════════════════════════════════════════ */}

      {/* ASSIGNED — merchant sees order details, Accept/Reject */}
      {order.status === 'ASSIGNED' && (
        <div className="space-y-3">
          {!isDeposit && bank?.accountNumber && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
              <p className="text-blue-700 font-semibold mb-1 text-xs">Send ₹{fiatAmount} to user's bank:</p>
              <div className="space-y-0.5 text-blue-900">
                <p><strong>{bank.accountHolderName || kyc?.name || 'User'}</strong></p>
                <p className="font-mono text-xs flex items-center gap-1">
                  AC: {bank.accountNumber}
                  <button onClick={() => copyText(bank.accountNumber!, 'Account no.')}><Copy className="h-3 w-3 text-blue-500" /></button>
                </p>
                <p className="text-xs">IFSC: {bank.ifscCode} · {bank.bankName}</p>
                {order.upiId && <p className="text-xs">UPI: <span className="font-mono">{order.upiId}</span></p>}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => onAccept(order._id)} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
              ✅ Accept Order
            </button>
            <button onClick={() => onReject(order._id)} className="flex-1 bg-red-50 hover:bg-red-100 text-red-600 font-semibold py-2.5 rounded-lg text-sm border border-red-200 transition-colors">
              ✕ Reject
            </button>
          </div>
        </div>
      )}

      {/* PROCESSING — waiting states differ per type */}
      {order.status === 'PROCESSING' && (
        <div className="space-y-3">
          {isDeposit ? (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
              <p className="font-semibold">⏳ Waiting for user to pay</p>
              <p className="text-xs mt-1">User is scanning QR / opening UPI app to pay you ₹{fiatAmount}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                <p className="text-blue-700 font-semibold mb-1 text-xs">Send ₹{fiatAmount} to:</p>
                <div className="space-y-0.5 text-blue-900">
                  <p><strong>{bank?.accountHolderName || kyc?.name || 'User'}</strong></p>
                  {bank?.accountNumber && (
                    <p className="font-mono text-xs flex items-center gap-1">
                      AC: {bank.accountNumber}
                      <button onClick={() => copyText(bank.accountNumber!, 'Account no.')}><Copy className="h-3 w-3 text-blue-500" /></button>
                    </p>
                  )}
                  {bank?.ifscCode && <p className="text-xs">IFSC: {bank.ifscCode} · {bank.bankName}</p>}
                  {order.upiId && (
                    <p className="text-xs flex items-center gap-1">
                      UPI: <span className="font-mono">{order.upiId}</span>
                      <button onClick={() => copyText(order.upiId!, 'UPI ID')}><Copy className="h-3 w-3 text-blue-500" /></button>
                    </p>
                  )}
                </div>
              </div>
              {onMarkPayoutSent && (
                <button onClick={() => onMarkPayoutSent(order._id)} className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
                  💸 I've Sent the Money — Confirm Payout
                </button>
              )}
              {onRaiseDispute && (
                <button onClick={() => onRaiseDispute(order._id)} className="w-full bg-orange-50 hover:bg-orange-100 text-orange-600 font-semibold py-2 rounded-lg text-sm border border-orange-200 transition-colors">
                  ⚠️ Cannot Process — Raise Dispute
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* PAID (DEPOSIT) — merchant sees UTR + proof, must confirm or dispute */}
      {order.status === 'PAID' && isDeposit && (
        <div className="space-y-3">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-green-700 font-semibold text-sm mb-2">User claims to have paid</p>
            {order.utrNumber && (
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-gray-500">UTR:</span>
                <span className="font-mono font-bold text-gray-900 text-sm">{order.utrNumber}</span>
                <button onClick={() => copyText(order.utrNumber!, 'UTR')}><Copy className="h-3.5 w-3.5 text-gray-400" /></button>
              </div>
            )}
            <p className="text-xs text-gray-500">Verify ₹{fiatAmount} credited in your UPI/bank app before confirming.</p>
          </div>
          {order.proofScreenshot && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Payment proof:</p>
              <a href={order.proofScreenshot} target="_blank" rel="noreferrer">
                <img src={order.proofScreenshot} alt="Payment proof" className="w-24 h-24 object-cover rounded-lg border border-gray-200 hover:opacity-80 cursor-pointer" />
              </a>
            </div>
          )}
          <div className="flex gap-2">
            {onConfirm && (
              <button onClick={() => onConfirm(order._id)} className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
                ✅ Payment Received — Release Tokens
              </button>
            )}
            {onRejectPayment && (
              <button onClick={() => onRejectPayment(order._id)} className="flex-1 bg-red-50 hover:bg-red-100 text-red-600 font-semibold py-2.5 rounded-lg text-sm border border-red-200 transition-colors">
                ❌ Payment NOT Received — Dispute
              </button>
            )}
          </div>
        </div>
      )}

      {/* COMPLETED — green card, show profit */}
      {order.status === 'COMPLETED' && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
          <p className="text-green-700 font-semibold">✅ Order Completed</p>
          {isDeposit && merchantProfit > 0 && (
            <p className="text-xs text-green-600 mt-1">
              Profit earned: <strong>₹{merchantProfit.toFixed(2)}</strong> <span className="text-gray-400">(buy/sell spread)</span>
            </p>
          )}
        </div>
      )}

      {/* DISPUTED — orange card, no action */}
      {order.status === 'DISPUTED' && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm">
          <p className="text-orange-700 font-semibold">🔍 Under Admin Review</p>
          <p className="text-xs text-orange-600 mt-1">This order is being reviewed by an admin. No action required from you.</p>
          {(order as any).disputeReason && (
            <p className="text-xs text-gray-500 mt-1">Reason: {(order as any).disputeReason}</p>
          )}
        </div>
      )}

      {/* CANCELLED */}
      {order.status === 'CANCELLED' && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
          <p className="text-gray-600">❌ Order Cancelled</p>
          {(order as any).cancelReason && <p className="text-xs text-gray-400 mt-1">{(order as any).cancelReason}</p>}
        </div>
      )}

      {/* ── View details link (always visible) ───────────────────────────── */}
      <button
        onClick={() => onViewDetails(order)}
        className="mt-3 w-full text-xs text-gray-400 hover:text-gray-600 text-center py-1"
      >
        View full details / chat →
      </button>
    </div>
  );
};

export default OrderCard;

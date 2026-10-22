// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The orders a merchant works, one line each with the ✓ and ✗ the order's
// state allows, and everything those open: the detail drawer, the "payment
// not received" dialog, the cash QR scanner and the "paid from which account"
// choice. Orders and Home both draw it (owner, 2026-10-21: open buys, open
// sells and disputes approved or rejected in place on the home screen), so the
// two screens act on an order the same way (§5).
import React, { useEffect, useState } from 'react';
import { useAuth } from '../services/AuthContext';
import { useOrderActions } from '../hooks/useOrderActions';
import { useMerchantAccount } from '../hooks/useMerchantAccount';
import { isMerchantAccountSession } from '../utils/actor';
import { useNow } from '../hooks/useCountdown';
import { useViewport } from '../hooks/useViewport';
import type { PaymentOrder } from '../types';
import OrderRow from './OrderRow';
import OrderDetail from './OrderDetail';
import PaymentNotReceivedDialog from './PaymentNotReceivedDialog';
import CashLinkScanner from './CashLinkScanner';
import PayoutFromAccountDialog from './PayoutFromAccountDialog';
import { ConfirmDialog } from './ui';

export const orderKey = (order: PaymentOrder): string => String(order._id || order.id || order.orderId);

export interface OrderWorkListProps {
  /** The lines to draw. */
  orders: PaymentOrder[];
  /** Every order the screen holds, so an order opened by id is found even off this list. */
  allOrders?: PaymentOrder[];
  /** Re-reads the orders after an action. */
  reload: () => Promise<void> | void;
  /** An order to open on arrival (a link from another screen). */
  openOrderId?: string | null;
}

const OrderWorkList: React.FC<OrderWorkListProps> = ({ orders, allOrders, reload, openOrderId = null }) => {
  const { merchant } = useAuth();
  const now = useNow();
  const { isMobile } = useViewport();
  const [selectedId, setSelectedId] = useState<string | null>(openOrderId);

  const { actions, confirmRequest, dismissConfirm, shouldCloseDetail, acknowledgeCloseDetail,
          rejectTarget, rejectBusy, dismissReject, submitPaymentNotReceived,
          scanTarget, scanBusy, dismissScan, sendCashLink,
          payoutTarget, dismissPayout, submitPayoutFrom } =
    useOrderActions(reload);
  // A merchant account's payment accounts: which one a buy is paid into, and
  // the choices a sell is marked paid from (owner, 2026-10-11).
  const merchantAccount = isMerchantAccountSession(merchant);
  const { overview: account, reload: reloadAccount } = useMerchantAccount(merchantAccount);
  const paymentAccounts = account?.accounts ?? [];
  // The choices are re-read when the dialog opens: an account paused a minute
  // ago is not offered.
  useEffect(() => { if (payoutTarget && merchantAccount) void reloadAccount(); }, [payoutTarget, merchantAccount, reloadAccount]);

  useEffect(() => {
    if (shouldCloseDetail) {
      setSelectedId(null);
      acknowledgeCloseDetail();
    }
  }, [shouldCloseDetail, acknowledgeCloseDetail]);

  const pool = allOrders ?? orders;
  const selected = selectedId ? pool.find((o) => orderKey(o) === selectedId) ?? null : null;
  const cardActions = { ...actions, onOpen: (order: PaymentOrder) => setSelectedId(orderKey(order)) };

  return (
    <>
      {orders.length > 0 && (
        // One line per order (owner, 2026-10-17); a tap opens the details.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {orders.map((order) => (
            <OrderRow key={orderKey(order)} order={order} merchant={merchant} now={now} actions={cardActions} />
          ))}
        </div>
      )}

      <OrderDetail
        order={selected}
        merchant={merchant}
        now={now}
        isMobile={isMobile}
        onClose={() => setSelectedId(null)}
        actions={cardActions}
        paymentAccounts={paymentAccounts}
      />
      <ConfirmDialog request={confirmRequest} onClose={dismissConfirm} />
      <PaymentNotReceivedDialog
        open={rejectTarget !== null}
        orderRef={String(rejectTarget?.orderId || rejectTarget?._id || '')}
        busy={rejectBusy}
        onCancel={dismissReject}
        onSubmit={submitPaymentNotReceived}
      />
      <CashLinkScanner order={scanTarget} busy={scanBusy} onClose={dismissScan} onSend={sendCashLink} />
      <PayoutFromAccountDialog
        order={payoutTarget}
        merchant={merchant}
        accounts={paymentAccounts}
        onCancel={dismissPayout}
        onSubmit={submitPayoutFrom}
      />
    </>
  );
};

export default OrderWorkList;

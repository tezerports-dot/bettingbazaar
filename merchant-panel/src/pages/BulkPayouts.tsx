// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * BulkPayouts.tsx  v1.0.0  (NEW FILE)
 *
 * Bulk payout dashboard for merchant to process daily withdrawal orders.
 *
 * FLOW:
 *   1. Merchant selects a date (defaults to today)
 *   2. Page loads all WITHDRAWAL orders for that bulkPayoutDate
 *   3. Merchant downloads CSV -> uploads to bank's bulk transfer portal (NEFT/IMPS)
 *   4. After transfers are done, merchant selects orders and clicks "Mark as Paid"
 *
 * BACKEND ENDPOINTS (all added in Batch 1 merchant.routes.js):
 *   GET  /api/merchant/bulk-payouts?date=YYYY-MM-DD
 *   GET  /api/merchant/bulk-payouts/export?date=YYYY-MM-DD
 *   POST /api/merchant/bulk-payouts/mark-paid  { orderIds: string[] }
 */
import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import toast from 'react-hot-toast';
import {
  Download, CheckCircle, RefreshCw, Calendar,
  IndianRupee, FileText, AlertCircle,
} from 'lucide-react';

interface BulkOrder {
  _id: string;
  orderId: string;
  userId: string;
  status: string;
  fiatAmount: number;
  tokenAmount: number;
  userPhone?: string;
  userBankDetails?: {
    accountHolderName?: string;
    accountNumber?: string;
    ifscCode?: string;
    bankName?: string;
  };
  userKycSnapshot?: {
    pan?: string;
    name?: string;
  };
  bulkPaidAt?: string;
  createdAt: string;
}

// Today's date in YYYY-MM-DD (local time)
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const BulkPayouts: React.FC = () => {
  const [date,           setDate]           = useState<string>(todayISO());
  const [orders,         setOrders]         = useState<BulkOrder[]>([]);
  const [loading,        setLoading]        = useState(false);
  const [selected,       setSelected]       = useState<Set<string>>(new Set());
  const [marking,        setMarking]        = useState(false);
  const [exporting,      setExporting]      = useState(false);
  const [summary,        setSummary]        = useState<{ count: number; totalFiat: number; totalTokens: number } | null>(null);

  useEffect(() => {
    loadOrders();
  }, [date]);

  const loadOrders = async () => {
    setLoading(true);
    setSelected(new Set());
    try {
      const data = await api.getBulkPayouts(date);
      setOrders(data.orders || []);
      setSummary(data.summary || null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load bulk payouts');
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const unpaid = orders.filter(o => !o.bulkPaidAt).map(o => o._id);
    if (selected.size === unpaid.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(unpaid));
    }
  };

  const handleMarkPaid = async () => {
    if (selected.size === 0) {
      toast.error('Select at least one order');
      return;
    }
    if (!confirm(`Mark ${selected.size} orders as paid? This will complete these withdrawal orders.`)) return;

    setMarking(true);
    try {
      const result = await api.markBulkPaid([...selected]);
      toast.success(`${result.count} orders marked as paid. Batch ID: ${result.batchId}`);
      await loadOrders();
    } catch (err: any) {
      toast.error(err.message || 'Failed to mark orders as paid');
    } finally {
      setMarking(false);
    }
  };

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      const data = await api.exportBulkPayouts(date);
      if (!data.rows?.length) {
        toast('No orders to export for this date');
        return;
      }

      // Build CSV
      const headers = [
        'S.No', 'Order ID', 'Beneficiary Name', 'Account Number', 'IFSC Code',
        'Bank Name', 'Amount (Rs.)', 'Tokens', 'Aadhaar', 'Mobile', 'Remark', 'Status',
      ];
      const rows = data.rows.map((r: any) => [
        r.sNo,
        r.orderId,
        r.beneficiaryName,
        r.accountNumber,
        r.ifscCode,
        r.bankName,
        r.amount,
        r.tokenAmount,
        r.aadhaarNumber,
        r.userMobile,
        r.remark,
        r.status,
      ]);

      const csvContent = [
        headers.join(','),
        ...rows.map((row: any[]) =>
          row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
        ),
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = data.filename || `bulk_payout_${date}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success(`Exported ${data.rows.length} orders to CSV`);
    } catch (err: any) {
      toast.error(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const unpaidOrders = orders.filter(o => !o.bulkPaidAt);
  const paidOrders   = orders.filter(o => !!o.bulkPaidAt);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Bulk Payouts</h1>
          <p className="text-gray-600 mt-1">Process daily withdrawal orders in bulk</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-2">
            <Calendar className="h-4 w-4 text-gray-500" />
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              max={todayISO()}
              className="text-sm text-gray-900 outline-none"
            />
          </div>
          <button
            onClick={loadOrders}
            disabled={loading}
            className="p-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <RefreshCw className={`h-4 w-4 text-gray-600 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white p-5 rounded-lg shadow border border-gray-200">
            <div className="flex items-center gap-3">
              <FileText className="h-8 w-8 text-blue-500" />
              <div>
                <p className="text-sm text-gray-600">Total Orders</p>
                <p className="text-2xl font-bold text-gray-900">{summary.count}</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-5 rounded-lg shadow border border-gray-200">
            <div className="flex items-center gap-3">
              <IndianRupee className="h-8 w-8 text-green-500" />
              <div>
                <p className="text-sm text-gray-600">Total Payout Amount</p>
                <p className="text-2xl font-bold text-green-600">
                  Rs.{(summary.totalFiat || 0).toLocaleString('en-IN')}
                </p>
              </div>
            </div>
          </div>
          <div className="bg-white p-5 rounded-lg shadow border border-gray-200">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-8 w-8 text-purple-500" />
              <div>
                <p className="text-sm text-gray-600">Tokens to Buy</p>
                <p className="text-2xl font-bold text-purple-600">
                  {(summary.totalTokens || 0).toLocaleString('en-IN')} BB
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Action Bar */}
      {orders.length > 0 && (
        <div className="bg-white p-4 rounded-lg shadow border border-gray-200 flex flex-wrap items-center gap-3">
          <button
            onClick={handleExportCSV}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
          >
            <Download className="h-4 w-4" />
            {exporting ? 'Exporting...' : 'Export CSV'}
          </button>

          {unpaidOrders.length > 0 && (
            <>
              <button
                onClick={toggleSelectAll}
                className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
              >
                {selected.size === unpaidOrders.length ? 'Deselect All' : 'Select All Unpaid'}
              </button>
              <button
                onClick={handleMarkPaid}
                disabled={marking || selected.size === 0}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
              >
                <CheckCircle className="h-4 w-4" />
                {marking ? 'Processing...' : `Mark ${selected.size || ''} as Paid`}
              </button>
            </>
          )}

          <span className="text-sm text-gray-500 ml-auto">
            {unpaidOrders.length} pending . {paidOrders.length} completed
          </span>
        </div>
      )}

      {/* Orders Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="animate-spin rounded-full h-10 w-10 border-b-4 border-blue-600 mx-auto"></div>
            <p className="mt-3 text-gray-600 text-sm">Loading orders...</p>
          </div>
        </div>
      ) : orders.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center border border-gray-200">
          <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-500 text-lg">No withdrawal orders for {date}</p>
          <p className="text-gray-400 text-sm mt-1">Withdrawal orders submitted before 7 PM IST appear here</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="p-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === unpaidOrders.length && unpaidOrders.length > 0}
                      onChange={toggleSelectAll}
                      className="rounded"
                    />
                  </th>
                  <th className="p-3 text-left text-gray-700 font-medium">Order</th>
                  <th className="p-3 text-left text-gray-700 font-medium">Beneficiary</th>
                  <th className="p-3 text-left text-gray-700 font-medium">Bank Details</th>
                  <th className="p-3 text-right text-gray-700 font-medium">Amount</th>
                  <th className="p-3 text-center text-gray-700 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orders.map(order => {
                  const isPaid    = !!order.bulkPaidAt;
                  const isChecked = selected.has(order._id);
                  return (
                    <tr
                      key={order._id}
                      className={`hover:bg-gray-50 transition-colors ${isChecked ? 'bg-blue-50' : ''}`}
                    >
                      <td className="p-3">
                        {!isPaid && (
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleSelect(order._id)}
                            className="rounded"
                          />
                        )}
                      </td>
                      <td className="p-3">
                        <div>
                          <p className="font-mono text-xs text-gray-500">{order.orderId}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {new Date(order.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                          </p>
                          {order.userPhone && (
                            <p className="text-xs text-gray-400">{order.userPhone}</p>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <div>
                          <p className="font-medium text-gray-900">
                            {order.userBankDetails?.accountHolderName || order.userKycSnapshot?.name || '--'}
                          </p>
                          {order.userKycSnapshot?.pan && (
                            <p className="text-xs text-gray-500 font-mono">{order.userKycSnapshot.pan}</p>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="text-xs space-y-0.5">
                          {order.userBankDetails?.accountNumber && (
                            <p className="font-mono text-gray-800">{order.userBankDetails.accountNumber}</p>
                          )}
                          {order.userBankDetails?.ifscCode && (
                            <p className="text-gray-500">{order.userBankDetails.ifscCode}</p>
                          )}
                          {order.userBankDetails?.bankName && (
                            <p className="text-gray-400">{order.userBankDetails.bankName}</p>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-right">
                        <p className="font-bold text-gray-900">Rs.{order.fiatAmount.toLocaleString('en-IN')}</p>
                        <p className="text-xs text-gray-500">{order.tokenAmount} BB</p>
                      </td>
                      <td className="p-3 text-center">
                        {isPaid ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-medium">
                            <CheckCircle className="h-3 w-3" />
                            Paid
                          </span>
                        ) : (
                          <span className="inline-flex px-2 py-1 rounded-full bg-yellow-100 text-yellow-700 text-xs font-medium">
                            {order.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {summary && (
                <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                  <tr>
                    <td colSpan={4} className="p-3 text-sm font-semibold text-gray-700 text-right">
                      Total ({orders.length} orders):
                    </td>
                    <td className="p-3 text-right font-bold text-gray-900">
                      Rs.{(summary.totalFiat || 0).toLocaleString('en-IN')}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
        <p className="font-semibold mb-1">[list] Bulk Payout Instructions</p>
        <ol className="list-decimal list-inside space-y-1 text-xs text-amber-700">
          <li>Export CSV and upload to your bank's bulk transfer portal (NEFT/IMPS)</li>
          <li>Complete all bank transfers before 9:30 PM IST</li>
          <li>Return here and select all transferred orders</li>
          <li>Click "Mark as Paid" -- this completes the withdrawal orders and notifies users</li>
          <li>Keep bank transfer reference numbers for your records</li>
        </ol>
      </div>
    </div>
  );
};

export default BulkPayouts;

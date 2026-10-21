// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant's two downloads as workbooks (owner, 2026-10-21): the business
 * ledger (`merchantLedger.businessLedger`) and the order report
 * (`merchantReports.orderReport`). Each kind of record is its own labelled,
 * coloured table with the transaction ID in the last column; the figures are
 * the rows the screen shows, never added up here again except a table's own
 * total line, which is the sum of the rows printed above it.
 */
import { istText } from '../reporting/xlsx.util.js';

const rupees = (paise) => Math.round(Number(paise ?? 0)) / 100;
const rangeText = (range) => (range.from || range.to
  ? `IST days ${range.from ?? 'from the start'} to ${range.to ?? 'today'}`
  : 'The last seven IST days');
const LOST_BY = { MERCHANT: 'Merchant', PLAYER: 'Player' };
const sumOf = (rows, key) => Math.round(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0) * 100) / 100;

const ORDER_COLUMNS = [
  { key: 'at', label: 'Time (IST)', type: 'time' },
  { key: 'rail', label: 'Paid by' },
  { key: 'account', label: 'Payment account' },
  { key: 'tokens', label: 'Amount (tokens = ₹)', type: 'money' },
  { key: 'state', label: 'State' },
  { key: 'id', label: 'Transaction ID' },
];
const ORDER_STATE = { COMPLETED: 'Completed', PAID: 'Paid, in the hold window' };

export function ledgerWorkbook(ledger) {
  const t = ledger.totals;
  const orders = (rows) => rows.map((r) => ({ at: r.at, rail: r.rail, account: r.account ?? '', tokens: rupees(r.tokensPaise), state: ORDER_STATE[r.state] ?? r.state, id: r.orderId }));
  const buys = orders(ledger.buys);
  const sells = orders(ledger.sells);
  const commission = ledger.commission.map((r) => ({
    at: r.at, team: r.team, role: r.role.charAt(0) + r.role.slice(1).toLowerCase(), share: rupees(r.sharePaise), id: r.commissionId,
  }));
  const pool = ledger.pool.map((r) => ({
    at: r.at, team: r.team, tokens: rupees(r.tokensPaise),
    paid: r.amountMinor === null ? '' : `${(r.amountMinor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${r.currency}`,
    inr: rupees(r.inrPaise), id: r.requestId,
  }));
  const disputes = ledger.disputes.map((r) => ({
    at: r.at, type: r.type === 'BUY' ? 'Buy' : 'Sell', tokens: rupees(r.tokensPaise),
    decision: r.decision ?? (r.state === 'DISPUTED' ? 'Open' : r.state), lostBy: LOST_BY[r.lostBy] ?? (r.lostBy ? r.lostBy : 'Nobody'),
    compensation: rupees(r.compensationPaise), id: r.orderId,
  }));

  const summary = [
    { item: 'Tokens bought from the platform', value: rupees(t.boughtPaise) },
    { item: 'Paid to the platform for them (₹)', value: rupees(t.paidToAdminPaise) },
    { item: `Player buys served (${t.userBuys})`, value: rupees(t.userBuysPaise) },
    { item: `Player sells paid (${t.userSells})`, value: rupees(t.userSellsPaise) },
    { item: 'Net with players (buys − sells)', value: rupees(t.netUserPaise) },
    { item: 'Commission earned', value: rupees(t.commissionPaise) },
    { item: 'Dispute compensation paid', value: -rupees(t.compensationPaise) },
    { item: 'Net commission (commission − compensation)', value: rupees(t.netCommissionPaise) },
    { item: 'Net profit', value: rupees(t.netProfitPaise) },
    { item: 'Tokens in your pool now (free)', value: rupees(t.poolAvailablePaise) },
    { item: 'Tokens in your pool now (held for open buys)', value: rupees(t.poolHeldPaise) },
  ];

  const table = ([sheet, heading], accent, columns, rows, totalKeys = []) => ({
    sheet, heading, accent, columns, rows,
    totals: rows.length && totalKeys.length ? Object.fromEntries(totalKeys.map((k) => [k, sumOf(rows, k)])) : undefined,
  });
  const tables = [
    table(['Summary', 'Summary'], 'slate', [{ key: 'item', label: 'Item', width: 52 }, { key: 'value', label: 'Amount (tokens = ₹)', type: 'money' }], summary),
    table(['Buys', `Player buys (${buys.length})`], 'green', ORDER_COLUMNS, buys, ['tokens']),
    table(['Sells', `Player sells (${sells.length})`], 'red', ORDER_COLUMNS, sells, ['tokens']),
    table(['Commission', `Commission (${commission.length})`], 'blue', [
      { key: 'at', label: 'Time (IST)', type: 'time' }, { key: 'team', label: 'Team' }, { key: 'role', label: 'Share as' },
      { key: 'share', label: 'Commission (tokens)', type: 'money' }, { key: 'id', label: 'Transaction ID' },
    ], commission, ['share']),
    table(['Pool trades', `Pool tokens bought from the platform (${pool.length})`], 'purple', [
      { key: 'at', label: 'Time (IST)', type: 'time' }, { key: 'team', label: 'Pool' },
      { key: 'tokens', label: 'Tokens', type: 'money' }, { key: 'paid', label: 'Paid' },
      { key: 'inr', label: 'In rupees', type: 'money' }, { key: 'id', label: 'Transaction ID' },
    ], pool),
    table(['Disputes', `Disputes (${disputes.length})`], 'orange', [
      { key: 'at', label: 'Raised (IST)', type: 'time' }, { key: 'type', label: 'Order' },
      { key: 'tokens', label: 'Amount (tokens)', type: 'money' }, { key: 'decision', label: 'Decision' },
      { key: 'lostBy', label: 'Lost by' }, { key: 'compensation', label: 'Compensation paid', type: 'money' },
      { key: 'id', label: 'Transaction ID' },
    ], disputes, ['compensation']),
  ];
  const subtitle = `${rangeText(ledger.range)}. Cancelled, expired and rejected orders are left out.${ledger.truncated ? ' A table over 5,000 rows shows its first 5,000; the summary counts every row.' : ''}`;
  return {
    sheets: [
      { name: 'Ledger', title: 'Business ledger', subtitle, tables },
      ...tables.slice(1).map((tb) => ({ name: tb.sheet, title: tb.heading, subtitle, tables: [{ ...tb, heading: undefined }] })),
    ],
  };
}

const RESULT = { CONFIRMED: '✓ Confirmed', REJECTED: '✗ Rejected', NONE: '' };

/** The order report: buys and sells as their own tables, the transaction ID last. */
export function orderReportWorkbook(report) {
  const columns = [
    { key: 'at', label: 'Time (IST)', type: 'time' },
    { key: 'user', label: 'User' },
    { key: 'utr', label: 'UTR' },
    { key: 'tokens', label: 'Amount (tokens)', type: 'money' },
    { key: 'result', label: '✓ / ✗' },
    { key: 'actedBy', label: 'Pressed by' },
    { key: 'state', label: 'State' },
    { key: 'id', label: 'Transaction ID' },
  ];
  const rowsOf = (type) => report.rows.filter((r) => r.type === type).map((r) => ({
    at: r.at, user: r.userId, utr: r.utr ?? '', tokens: Number(r.tokenAmount) || 0,
    result: RESULT[r.result] ?? '', actedBy: r.actedBy?.name ?? '', state: r.state, id: r.orderId,
  }));
  const buys = rowsOf('DEPOSIT');
  const sells = rowsOf('WITHDRAWAL');
  const total = (rows) => (rows.length ? { tokens: sumOf(rows, 'tokens') } : undefined);
  return {
    sheets: [{
      name: 'Orders', title: 'Order report', subtitle: `${rangeText(report.range)}. Generated ${istText(new Date())}.`,
      tables: [
        { heading: `Buys (${buys.length})`, accent: 'green', columns, rows: buys, totals: total(buys) },
        { heading: `Sells (${sells.length})`, accent: 'red', columns, rows: sells, totals: total(sells) },
      ],
    }],
  };
}

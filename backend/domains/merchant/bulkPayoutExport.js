export function buildBulkPayoutExportRows(orders) {
  return orders.map((o, idx) => ({
    sNo:             idx + 1,
    orderId:         o.orderId,
    beneficiaryName: o.userBankDetails?.accountHolderName || '',
    accountNumber:   o.userBankDetails?.accountNumber || '',
    ifscCode:        o.userBankDetails?.ifscCode || '',
    bankName:        o.userBankDetails?.bankName || '',
    amount:          o.amount || 0,
    tokenAmount:     o.tokenAmount || 0,
    remark:          `BB Token Sale ${o.orderId}`,
    status:          o.status,
    createdAt:       o.createdAt,
    bulkPayoutDate:  o.bulkPayoutDate,
    bulkPaidAt:      o.bulkPaidAt || null,
  }));
}

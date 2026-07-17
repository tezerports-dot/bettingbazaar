import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBulkPayoutExportRows } from '../../domains/merchant/bulkPayoutExport.js';

test('bulk payout export maps bank details and monetary values from the correct sources', () => {
  const rows = buildBulkPayoutExportRows([
    {
      orderId: 'W-1',
      amount: 975,
      fiatAmount: 9999,
      tokenAmount: 1000,
      userBankDetails: {
        accountHolderName: 'A User',
        accountNumber: '1234567890',
        ifscCode: 'IFSC0001',
        bankName: 'Test Bank',
      },
      status: 'PAID',
      createdAt: '2026-07-17T00:00:00.000Z',
      bulkPayoutDate: '2026-07-17T00:00:00.000Z',
    },
    {
      orderId: 'W-2',
      amount: 485,
      fiatAmount: 9999,
      tokenAmount: 500,
      userBankDetails: {
        accountHolderName: 'B User',
        accountNumber: '0987654321',
        ifscCode: 'IFSC0002',
        bankName: 'Other Bank',
      },
      status: 'COMPLETED',
    },
  ]);

  assert.equal(rows[0].amount, 975);
  assert.equal(rows[0].tokenAmount, 1000);
  assert.equal(rows[0].beneficiaryName, 'A User');
  assert.equal(rows[0].accountNumber, '1234567890');
  assert.equal(rows[0].ifscCode, 'IFSC0001');
  assert.equal(rows[0].bankName, 'Test Bank');
  assert.equal(rows[1].amount, 485);
  assert.equal(rows[1].tokenAmount, 500);
});

import { describe, expect, it } from 'vitest';
import { buildBulkPayoutExportRows } from '../../domains/merchant/bulkPayoutExport.js';

describe('bulk payout export mapping', () => {
  it('maps bank details and monetary values from the correct sources', () => {
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

    expect(rows[0].amount).toBe(975);
    expect(rows[0].tokenAmount).toBe(1000);
    expect(rows[0].beneficiaryName).toBe('A User');
    expect(rows[0].accountNumber).toBe('1234567890');
    expect(rows[0].ifscCode).toBe('IFSC0001');
    expect(rows[0].bankName).toBe('Test Bank');
    expect(rows[1].amount).toBe(485);
    expect(rows[1].tokenAmount).toBe(500);
  });
});

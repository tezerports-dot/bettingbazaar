// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The schema's list of sizes a payment account may take (`buy_sizes`,
 * `sell_sizes`, their DEFAULT and `merchant_payment_accounts_sizes_known`) is
 * the seven ORDER_SIZES (denominations.js), spelled four times in SQL. A size
 * added to one place and not the other would be refused, or defaulted, wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORDER_SIZES } from '../../domains/merchant/denominations.js';

const schema = readFileSync(fileURLToPath(new URL('../../../database/schema.sql', import.meta.url)), 'utf8');

describe('payment account sizes in the schema', () => {
  it('every spelling of the list is ORDER_SIZES', () => {
    const block = schema.slice(schema.indexOf('Which order sizes each account takes'), schema.indexOf('merchant_payment_accounts_sizes_known CHECK') + 400);
    const lists = [...block.matchAll(/'\{([0-9,]+)\}'/g)].map((m) => m[1].split(',').map(Number));
    expect(lists.length).toBe(4);
    for (const list of lists) expect(list).toEqual([...ORDER_SIZES]);
  });
});

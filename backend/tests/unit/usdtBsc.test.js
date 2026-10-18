// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Unit tests for the one door to BNB Smart Chain (`payment/usdtBsc.js`):
// address derivation from the account xpub, and reading USDT transfers.
import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import {
  parseAccountXpub, deriveDepositAddress, keyIdOf, rawToMicro, usdtTransfersTo, addressTopic,
  BSC_USDT_CONTRACT, TRANSFER_TOPIC,
} from '../../domains/payment/usdtBsc.js';

// BIP-39 test vector "abandon abandon … about": its account key at m/44'/60'/0'.
const XPUB = 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt';

describe('deriving deposit addresses', () => {
  it('matches the well-known addresses of the test vector (m/44\'/60\'/0\'/0/i)', () => {
    const key = parseAccountXpub(XPUB);
    expect(deriveDepositAddress(key, 0)).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94');
    expect(deriveDepositAddress(key, 1)).toBe('0x6fac4d18c912343bf86fa7049364dd4e424ab9c0');
  });

  it('gives a different address for every index, and the same one every time', () => {
    const key = parseAccountXpub(XPUB);
    const seen = new Set(Array.from({ length: 20 }, (_, i) => deriveDepositAddress(key, i)));
    expect(seen.size).toBe(20);
    expect(deriveDepositAddress(key, 7)).toBe(deriveDepositAddress(parseAccountXpub(XPUB), 7));
  });

  it('refuses a missing key, a private key and a key at the wrong depth', () => {
    expect(() => parseAccountXpub('')).toThrow(/not set/);
    const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
    expect(() => parseAccountXpub(root.privateExtendedKey)).toThrow(/PRIVATE/);
    expect(() => parseAccountXpub(root.publicExtendedKey)).toThrow(/depth 3/);
    expect(() => parseAccountXpub('xpub-nonsense')).toThrow(/not a valid/);
  });

  it('refuses an index outside BIP-32\'s non-hardened range', () => {
    const key = parseAccountXpub(XPUB);
    expect(() => deriveDepositAddress(key, -1)).toThrow(RangeError);
    expect(() => deriveDepositAddress(key, 2 ** 31)).toThrow(RangeError);
    expect(() => deriveDepositAddress(key, 1.5)).toThrow(RangeError);
  });

  it('names the key tree with a short stable id', () => {
    expect(keyIdOf(parseAccountXpub(XPUB))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('reading USDT transfers', () => {
  it('turns 18-decimal raw units into micro-USDT, rounding down', () => {
    expect(rawToMicro(10n ** 18n)).toBe(1_000_000n);
    expect(rawToMicro('0x' + (12345678n * 10n ** 12n + 999n).toString(16))).toBe(12_345_678n);
  });

  it('asks for transfers to the addresses, and drops removed logs and other contracts', async () => {
    const to = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
    let asked;
    const log = (over) => ({
      address: BSC_USDT_CONTRACT, removed: false, blockNumber: '0x10', logIndex: '0x2',
      transactionHash: '0xABC', data: `0x${(5n * 10n ** 18n).toString(16)}`,
      topics: [TRANSFER_TOPIC, addressTopic(`0x${'1'.repeat(40)}`), addressTopic(to)], ...over,
    });
    const fetchImpl = async (_url, init) => {
      asked = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: [
        log({}), log({ removed: true }), log({ address: '0x0000000000000000000000000000000000000001' }),
      ] }));
    };
    const out = await usdtTransfersTo([to], 16, 20, { url: 'http://node', fetchImpl });
    expect(asked.method).toBe('eth_getLogs');
    expect(asked.params[0]).toMatchObject({ address: BSC_USDT_CONTRACT, fromBlock: '0x10', toBlock: '0x14' });
    expect(asked.params[0].topics[2]).toEqual([addressTopic(to)]);
    expect(out).toEqual([{
      txHash: '0xabc', logIndex: 2, blockNumber: 16, from: `0x${'1'.repeat(40)}`, to, amountMicro: 5_000_000n,
    }]);
  });

  it('throws on an RPC error, so the watcher retries instead of moving on', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'limit exceeded' } }));
    await expect(usdtTransfersTo(['0x' + '2'.repeat(40)], 1, 2, { url: 'http://node', fetchImpl }))
      .rejects.toThrow(/limit exceeded/);
  });
});

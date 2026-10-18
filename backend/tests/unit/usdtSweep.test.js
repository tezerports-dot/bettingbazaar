// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The offline USDT sweep tool (scripts/usdt-sweep.mjs): the phrase derives the
 * same addresses the server hands out, a transaction is signed exactly as the
 * chain expects, and a line is swept only when its address is the one its index
 * derives. The chain is a fake that answers the JSON-RPC calls the tool makes.
 */
import { describe, it, expect } from 'vitest';
import {
  seedFromMnemonic, accountFromSeed, depositKey, gasKey, addressOf, signLegacyTx, rlp,
  transferData, balanceOfData, parseSweepFile, runSweep, accountSummary,
} from '../../../scripts/usdt-sweep.mjs';
import { BSC_USDT_CONTRACT, keyIdOf, parseAccountXpub } from '../../domains/payment/usdtBsc.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_XPUB = 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt';
const account = accountFromSeed(seedFromMnemonic(PHRASE));
const TREASURY = `0x${'7'.repeat(40)}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

describe('keys', () => {
  it('derives, from the phrase, the very account the server holds as its xpub', () => {
    expect(account.publicExtendedKey).toBe(TEST_XPUB);
    expect(keyIdOf(account)).toBe(keyIdOf(parseAccountXpub(TEST_XPUB)));
    expect(addressOf(depositKey(account, 0))).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94');
    expect(addressOf(depositKey(account, 1))).toBe('0x6fac4d18c912343bf86fa7049364dd4e424ab9c0');
  });

  it('prints, for a phrase, the xpub the server is given and the key id its addresses carry', () => {
    expect(accountSummary(account)).toEqual({ xpub: TEST_XPUB, keyId: keyIdOf(account), gasWallet: addressOf(gasKey(account)) });
    // A rotated phrase is a different key: its addresses can never be mistaken for the old one's.
    const other = accountFromSeed(seedFromMnemonic('legal winner thank year wave sausage worth useful legal winner thank yellow'));
    expect(accountSummary(other).keyId).not.toBe(keyIdOf(account));
    expect(addressOf(depositKey(other, 0))).not.toBe(addressOf(depositKey(account, 0)));
  });

  it('keeps the gas wallet off the deposit branch', () => {
    const gas = addressOf(gasKey(account));
    for (let i = 0; i < 5; i += 1) expect(addressOf(depositKey(account, i))).not.toBe(gas);
  });

  it('refuses a phrase of the wrong length', () => {
    expect(() => seedFromMnemonic('abandon about')).toThrow(/2 words/);
    expect(() => seedFromMnemonic(undefined)).toThrow(/0 words/);
  });
});

describe('transactions', () => {
  it('signs the EIP-155 reference transaction byte for byte', () => {
    const key = new Uint8Array(32).fill(0x46);
    expect(signLegacyTx({
      nonce: 9n, gasPrice: 20_000_000_000n, gasLimit: 21_000n,
      to: `0x${'35'.repeat(20)}`, value: 10n ** 18n, chainId: 1,
    }, key)).toBe('0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83');
  });

  it('encodes RLP for the short and long forms', () => {
    expect(Buffer.from(rlp(0n)).toString('hex')).toBe('80');
    expect(Buffer.from(rlp(15n)).toString('hex')).toBe('0f');
    expect(Buffer.from(rlp(1024n)).toString('hex')).toBe('820400');
    expect(Buffer.from(rlp([])).toString('hex')).toBe('c0');
    expect(Buffer.from(rlp(new Uint8Array(56).fill(1))).toString('hex').slice(0, 4)).toBe('b838');
  });

  it('calls the token’s transfer and balanceOf', () => {
    expect(transferData(TREASURY, 255n)).toBe(`0xa9059cbb${'0'.repeat(24)}${'7'.repeat(40)}${'0'.repeat(62)}ff`);
    expect(balanceOfData(TREASURY)).toBe(`0x70a08231${'0'.repeat(24)}${'7'.repeat(40)}`);
  });
});

describe('the sweep file', () => {
  it('reads the admin’s CSV by its column names', () => {
    const rows = parseSweepFile('orderId,address,keyId,derivationIndex,usdtReceived,state\nORD-1,0xABC,ab12,7,100,COMPLETED\n');
    expect(rows).toEqual([{ orderId: 'ORD-1', address: '0xabc', keyId: 'ab12', derivationIndex: 7 }]);
    expect(() => parseSweepFile('orderId,address\nx,y')).toThrow(/keyId/);
  });
});

/** A chain that knows balances and records what was sent. */
function fakeChain({ usdt = {}, bnb = {} } = {}) {
  const sent = [];
  let n = 0;
  const rpc = async (method, params = []) => {
    switch (method) {
      case 'eth_call': {
        const owner = `0x${params[0].data.slice(-40)}`;
        return `0x${(usdt[owner] ?? 0n).toString(16)}`;
      }
      case 'eth_gasPrice': return '0x3b9aca00'; // 1 gwei
      case 'eth_estimateGas': return '0xea60'; // 60,000
      case 'eth_getBalance': return `0x${(bnb[params[0]] ?? 0n).toString(16)}`;
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_sendRawTransaction': { sent.push(params[0]); n += 1; return hash(n); }
      case 'eth_getTransactionReceipt': return { status: '0x1' };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, sent };
}

/** Raw token units (18 decimals) of a USDT amount. */
const RAW = (usdtUnits) => BigInt(Math.round(usdtUnits * 1e6)) * 10n ** 12n;

describe('runSweep', () => {
  const a0 = addressOf(depositKey(account, 0));
  const a1 = addressOf(depositKey(account, 1));
  const keyId = keyIdOf(account);

  it('plans and sends nothing on a dry run', async () => {
    const chain = fakeChain({ usdt: { [a0]: RAW(100) } });
    const out = await runSweep({ rows: [{ orderId: 'O0', address: a0, keyId, derivationIndex: 0 }], account, treasury: TREASURY, rpc: chain.rpc, log: () => {} });
    expect(out[0]).toMatchObject({ status: 'planned', usdt: '100 USDT' });
    expect(chain.sent).toHaveLength(0);
  });

  it('tops up gas, sends the whole balance to the treasury, and reports each sweep once mined', async () => {
    const chain = fakeChain({ usdt: { [a0]: RAW(100) } });
    const swept = [];
    const out = await runSweep({
      rows: [{ orderId: 'O0', address: a0, keyId, derivationIndex: 0 }], account, treasury: TREASURY, rpc: chain.rpc,
      send: true, log: () => {}, onSwept: (o, h) => swept.push([o, h]), pollMs: 1,
    });
    expect(out[0].status).toBe('swept');
    expect(chain.sent).toHaveLength(2); // the gas top-up, then the transfer
    // Signed by the deposit address's own key (signatures are deterministic),
    // to the token contract, moving the whole balance to the treasury, with
    // the estimate plus a fifth as its gas.
    expect(chain.sent[1]).toBe(signLegacyTx({
      nonce: 0n, gasPrice: 1_000_000_000n, gasLimit: 72_000n, to: BSC_USDT_CONTRACT, data: transferData(TREASURY, RAW(100)),
    }, depositKey(account, 0).privateKey));
    // The top-up comes from the gas wallet and covers exactly that fee.
    expect(chain.sent[0]).toBe(signLegacyTx({
      nonce: 0n, gasPrice: 1_000_000_000n, gasLimit: 21_000n, to: a0, value: 72_000n * 1_000_000_000n,
    }, gasKey(account).privateKey));
    expect(swept).toEqual([['O0', hash(2)]]);
  });

  it('needs no top-up when the address already holds enough BNB', async () => {
    const chain = fakeChain({ usdt: { [a0]: RAW(5) }, bnb: { [a0]: 10n ** 17n } });
    await runSweep({ rows: [{ orderId: 'O0', address: a0, keyId, derivationIndex: 0 }], account, treasury: TREASURY, rpc: chain.rpc, send: true, log: () => {}, pollMs: 1 });
    expect(chain.sent).toHaveLength(1);
  });

  it('refuses a line whose index does not derive its address, or another account’s, and moves nothing for it', async () => {
    const chain = fakeChain({ usdt: { [a0]: RAW(100), [a1]: RAW(100) } });
    const out = await runSweep({
      rows: [
        { orderId: 'SWAPPED', address: a1, keyId, derivationIndex: 0 },
        { orderId: 'OTHER', address: a0, keyId: '0123456789abcdef', derivationIndex: 0 },
      ],
      account, treasury: TREASURY, rpc: chain.rpc, send: true, log: () => {}, pollMs: 1,
    });
    expect(out.map((l) => l.status)).toEqual(['refused', 'refused']);
    expect(chain.sent).toHaveLength(0);
  });

  it('skips an address already emptied, so a stopped run can be run again', async () => {
    const chain = fakeChain();
    const out = await runSweep({ rows: [{ orderId: 'O0', address: a0, keyId, derivationIndex: 0 }], account, treasury: TREASURY, rpc: chain.rpc, send: true, log: () => {} });
    expect(out[0].status).toBe('empty');
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses a treasury that is not an address before touching the chain', async () => {
    await expect(runSweep({ rows: [], account, treasury: 'T123', rpc: async () => { throw new Error('called'); } }))
      .rejects.toThrow(/USDT_TREASURY_ADDRESS/);
  });
});

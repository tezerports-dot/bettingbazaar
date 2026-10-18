// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * usdtBsc.js — the one door to BNB Smart Chain, for USDT deposits paid to the
 * platform itself (owner, 2026-10-18: BSC only, one address per order).
 *
 * ── What the server holds, and what it never holds ─────────────────────────
 * An EXTENDED PUBLIC KEY (`USDT_BEP20_XPUB`, the BIP-44 account key at
 * m/44'/60'/0'). From it the server derives a fresh receiving address per
 * order, child `0/<index>`, and can watch it. It cannot spend from any of them:
 * the private keys come from the owner's recovery phrase, which lives offline
 * and is used only by the sweep tool on the owner's own machine
 * (`scripts/usdt-sweep.mjs`). A server that is broken into leaks which
 * addresses are ours, never the coins.
 *
 * ── The chain, through one thin adapter (§17.1.4) ──────────────────────────
 * Two JSON-RPC calls, `eth_blockNumber` and `eth_getLogs`, against
 * `BSC_RPC_URL` (any BSC node or provider). Nothing else on the platform
 * speaks to the chain.
 *
 * ── Amounts ─────────────────────────────────────────────────────────────────
 * BSC's USDT (BEP-20, "BSC-USD") has 18 decimals. The platform counts USDT in
 * MICRO-USDT (6 decimals), integers, so a raw value is divided by 10^12 and
 * the remainder (below a millionth of a cent) is ignored.
 */
import { HDKey } from '@scure/bip32';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/** The USDT token contract on BNB Smart Chain mainnet. */
export const BSC_USDT_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
export const BSC_CHAIN_ID = 56;
export const BSC_USDT_DECIMALS = 18;
/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Raw token units in one micro-USDT. */
const RAW_PER_MICRO = 10n ** BigInt(BSC_USDT_DECIMALS - 6);
/** Micro-USDT in one USDT. */
export const MICRO_PER_USDT = 1_000_000;

/** Highest non-hardened child index (BIP-32). */
export const MAX_DERIVATION_INDEX = 0x7fffffff;

const unavailable = (message) => Object.assign(new Error(message), { status: 503, code: 'USDT_DEPOSITS_UNAVAILABLE' });

/** Raw token units (a BigInt or hex string) to whole micro-USDT, rounded down. */
export function rawToMicro(raw) {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  return value / RAW_PER_MICRO;
}

/** Lower-case 0x address from a 33- or 65-byte secp256k1 public key. */
export function addressFromPublicKey(publicKey) {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
}

/**
 * The account key the server derives from, parsed once and checked: an
 * extended PUBLIC key at depth 3 (m/44'/60'/0'). A private key here is
 * refused, because it would put spending power on the server.
 */
export function parseAccountXpub(xpub) {
  const text = String(xpub ?? '').trim();
  if (!text) throw unavailable('USDT deposits are not configured: USDT_BEP20_XPUB is not set.');
  if (/^[xyzt]prv/i.test(text)) {
    throw unavailable('USDT_BEP20_XPUB holds a PRIVATE key. Put only the account xpub on the server.');
  }
  let key;
  try { key = HDKey.fromExtendedKey(text); } catch {
    throw unavailable('USDT_BEP20_XPUB is not a valid extended public key.');
  }
  if (key.privateKey) throw unavailable('USDT_BEP20_XPUB holds a PRIVATE key. Put only the account xpub on the server.');
  if (key.depth !== 3) {
    throw unavailable(`USDT_BEP20_XPUB must be the account key at m/44'/60'/0' (depth 3); this one is at depth ${key.depth}.`);
  }
  return key;
}

/**
 * A short, stable name for the key tree (first 8 bytes of SHA-256 of the
 * account public key). Stored on each address so an address derived from a
 * different key is never mistaken for one of this key's.
 */
export function keyIdOf(accountKey) {
  return bytesToHex(sha256(accountKey.publicKey).slice(0, 8));
}

/** The receiving address at child 0/<index> of the account key. */
export function deriveDepositAddress(accountKey, index) {
  if (!Number.isInteger(index) || index < 0 || index > MAX_DERIVATION_INDEX) {
    throw new RangeError(`deriveDepositAddress: index must be 0..${MAX_DERIVATION_INDEX}, got ${index}`);
  }
  return addressFromPublicKey(accountKey.deriveChild(0).deriveChild(index).publicKey);
}

let cached = null;
/** The configured account key, from the environment, parsed once per value. */
export function configuredAccountKey(env = process.env) {
  const xpub = env.USDT_BEP20_XPUB;
  if (cached?.xpub === xpub) return cached.key;
  const key = parseAccountXpub(xpub);
  cached = { xpub, key, keyId: keyIdOf(key) };
  return key;
}

/** Whether this deployment can take USDT deposits at all (both settings present). */
export function usdtDepositsConfigured(env = process.env) {
  try { configuredAccountKey(env); } catch { return false; }
  return Boolean(String(env.BSC_RPC_URL ?? '').trim());
}

// ── The RPC adapter ─────────────────────────────────────────────────────────

let rpcId = 0;
/**
 * One JSON-RPC call. Throws on a transport failure, an HTTP error or an RPC
 * error: the watcher treats every one the same way (try again next tick).
 */
export async function rpc(method, params, { url = process.env.BSC_RPC_URL, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!String(url ?? '').trim()) throw unavailable('USDT deposits are not configured: BSC_RPC_URL is not set.');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`BSC RPC ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`BSC RPC ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

export async function latestBlock(opts) {
  return Number(BigInt(await rpc('eth_blockNumber', [], opts)));
}

/** An address as a 32-byte log topic. */
export const addressTopic = (address) => `0x${'0'.repeat(24)}${String(address).toLowerCase().replace(/^0x/, '')}`;
/** A 32-byte log topic back to an address. */
const topicAddress = (topic) => `0x${String(topic).slice(-40).toLowerCase()}`;

/**
 * Every USDT transfer TO one of `addresses` in blocks `from`..`to`, inclusive.
 * One call: the recipient topic is an OR list.
 *
 * @returns {Promise<Array<{txHash, logIndex, blockNumber, from, to, amountMicro}>>}
 *   `amountMicro` is a BigInt.
 */
export async function usdtTransfersTo(addresses, fromBlock, toBlock, opts) {
  if (!addresses.length || toBlock < fromBlock) return [];
  const logs = await rpc('eth_getLogs', [{
    address: BSC_USDT_CONTRACT,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    topics: [TRANSFER_TOPIC, null, addresses.map(addressTopic)],
  }], opts);
  return (logs ?? [])
    // A removed log belongs to a block that was reorganised away.
    .filter((l) => !l.removed && String(l.address).toLowerCase() === BSC_USDT_CONTRACT)
    .map((l) => ({
      txHash: String(l.transactionHash).toLowerCase(),
      logIndex: Number(BigInt(l.logIndex)),
      blockNumber: Number(BigInt(l.blockNumber)),
      from: topicAddress(l.topics[1]),
      to: topicAddress(l.topics[2]),
      amountMicro: rawToMicro(l.data === '0x' ? 0n : BigInt(l.data)),
    }));
}

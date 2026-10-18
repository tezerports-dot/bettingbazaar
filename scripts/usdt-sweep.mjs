#!/usr/bin/env node
// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * usdt-sweep.mjs — move the USDT players paid to their per-order deposit
 * addresses into the platform's treasury address (owner, 2026-10-18: BSC only,
 * one address per order, swept per order).
 *
 * RUN THIS ON THE OWNER'S OWN MACHINE, NEVER ON A SERVER. It is the only thing
 * that ever holds the recovery phrase; the server holds only the account xpub
 * (`USDT_BEP20_XPUB`) and cannot spend.
 *
 *   1. Admin › USDT Deposits › Download sweep file  (usdt-sweep.csv). It names
 *      your final wallet (set on the same page), where the USDT goes.
 *   2. USDT_SWEEP_MNEMONIC="twelve or twenty-four words"  BSC_RPC_URL=https://… \
 *      node scripts/usdt-sweep.mjs usdt-sweep.csv            (a dry run: the plan)
 *      node scripts/usdt-sweep.mjs usdt-sweep.csv --send     (signs and sends)
 *      Before sending it prints the final wallet and asks you to type its last
 *      6 characters, so a file changed on a broken-into server sends nothing
 *      (or pass --confirm <last 6>). USDT_TREASURY_ADDRESS, if set, must match it.
 *   3. Admin › USDT Deposits › paste usdt-sweep-results.csv › Record results
 *
 * For each line it derives the key at m/44'/60'/0'/0/<derivationIndex> and
 * refuses the line unless that key's address is the address in the file and
 * the account matches the file's keyId: a wrong phrase or an edited file moves
 * nothing. A deposit address holds no BNB for gas, so the tool first tops it
 * up from the GAS WALLET, the same phrase's m/44'/60'/0'/1/0 (printed at the
 * start; keep some BNB on it), then sends the address's whole USDT balance to
 * the treasury. A line is written to the results file only once its transfer
 * is mined and succeeded, so a run that stops halfway can simply be run again:
 * an address already emptied is skipped.
 *
 * To set up or rotate the key: USDT_SWEEP_MNEMONIC="…" node scripts/usdt-sweep.mjs --xpub
 * prints the USDT_BEP20_XPUB for that phrase, its key id and gas wallet
 * (docs/governance/USDT_KEY_ROTATION.md).
 *
 * Optional: USDT_SWEEP_PASSPHRASE (a BIP-39 passphrase, if the phrase has one),
 * --out <file> (default usdt-sweep-results.csv).
 */
import { pbkdf2Sync } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HDKey } from '@scure/bip32';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  BSC_CHAIN_ID, BSC_USDT_CONTRACT, addressFromPublicKey, deriveDepositAddress, keyIdOf,
} from '../backend/domains/payment/usdtBsc.js';

export const ACCOUNT_PATH = "m/44'/60'/0'";
/** Gas for a plain BNB transfer. */
const BNB_TRANSFER_GAS = 21_000n;
/** Used when the node will not estimate a token transfer. */
const FALLBACK_TOKEN_GAS = 80_000n;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// ── Keys ─────────────────────────────────────────────────────────────────────

/** BIP-39 seed: PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase. */
export function seedFromMnemonic(mnemonic, passphrase = '') {
  const words = String(mnemonic ?? '').normalize('NFKD').trim().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error(`USDT_SWEEP_MNEMONIC has ${words.length} words; a recovery phrase has 12, 15, 18, 21 or 24.`);
  }
  return pbkdf2Sync(words.join(' '), `mnemonic${String(passphrase).normalize('NFKD')}`, 2048, 64, 'sha512');
}

/** The account key (m/44'/60'/0'), with its private half. */
export function accountFromSeed(seed) {
  return HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH);
}

/** A deposit address's key: child 0/<index>, the same derivation the server watches. */
export function depositKey(account, index) {
  return account.deriveChild(0).deriveChild(index);
}

/** The gas wallet: child 1/0, never a deposit address. */
export function gasKey(account) {
  return account.deriveChild(1).deriveChild(0);
}

export const addressOf = (key) => addressFromPublicKey(key.publicKey);

// ── Transactions ─────────────────────────────────────────────────────────────

/** Big-endian bytes of a non-negative integer, with no leading zeros (0 → empty). */
function intBytes(n) {
  const v = BigInt(n);
  if (v < 0n) throw new Error('negative integer in a transaction');
  if (v === 0n) return new Uint8Array();
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(hex);
}

/** Recursive-length-prefix encoding of bytes and lists of them. */
export function rlp(item) {
  if (Array.isArray(item)) {
    const body = concat(item.map(rlp));
    return concat([lengthPrefix(body.length, 0xc0), body]);
  }
  const bytes = item instanceof Uint8Array ? item : intBytes(item);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concat([lengthPrefix(bytes.length, 0x80), bytes]);
}
function lengthPrefix(length, offset) {
  if (length < 56) return Uint8Array.of(offset + length);
  const len = intBytes(length);
  return concat([Uint8Array.of(offset + 55 + len.length), len]);
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const hexBytes = (hex) => hexToBytes(String(hex).replace(/^0x/, ''));

/**
 * A signed legacy transaction with EIP-155 replay protection, as the 0x hex
 * `eth_sendRawTransaction` takes.
 */
export function signLegacyTx({ nonce, gasPrice, gasLimit, to, value = 0n, data = '0x', chainId = BSC_CHAIN_ID }, privateKey) {
  const fields = [intBytes(nonce), intBytes(gasPrice), intBytes(gasLimit), hexBytes(to), intBytes(value), hexBytes(data)];
  const digest = keccak_256(rlp([...fields, intBytes(chainId), new Uint8Array(), new Uint8Array()]));
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered' });
  const v = BigInt(chainId) * 2n + 35n + BigInt(sig[0]);
  return `0x${bytesToHex(rlp([...fields, intBytes(v), trimZeros(sig.slice(1, 33)), trimZeros(sig.slice(33, 65))]))}`;
}
function trimZeros(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i += 1;
  return bytes.slice(i);
}

const word = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');
/** ERC-20 `transfer(to, amount)`. */
export const transferData = (to, amountRaw) => `0xa9059cbb${word(to)}${word(BigInt(amountRaw).toString(16))}`;
/** ERC-20 `balanceOf(owner)`. */
export const balanceOfData = (owner) => `0x70a08231${word(owner)}`;

// ── The sweep file ───────────────────────────────────────────────────────────

/** Rows of the admin's sweep file (`GET /api/admin/usdt-deposits/sweep.csv`). */
export function parseSweepFile(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const cells = (l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"').replace(/^'/, ''));
  const head = cells(lines[0]);
  const col = (name) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`The sweep file has no "${name}" column. Download it again from Admin › USDT Deposits.`);
    return i;
  };
  const [o, a, k, d, w] = ['orderId', 'address', 'keyId', 'derivationIndex', 'finalWallet'].map(col);
  return lines.slice(1).map((l) => {
    const c = cells(l);
    return {
      orderId: c[o], address: String(c[a]).toLowerCase(), keyId: c[k], derivationIndex: Number(c[d]),
      finalWallet: String(c[w]).toLowerCase(),
    };
  });
}

/**
 * Where this run sends: the one final wallet the sweep file names, which
 * `USDT_TREASURY_ADDRESS` (when set on this machine) must equal. Throws when
 * the file names none, or more than one, or they disagree.
 */
export function destinationFor(rows, envAddress) {
  const named = [...new Set(rows.map((r) => r.finalWallet))];
  if (named.length > 1) throw new Error(`The sweep file names ${named.length} different final wallets. Download it again.`);
  const fromFile = named[0];
  const local = String(envAddress ?? '').trim().toLowerCase();
  if (fromFile !== undefined && !ADDRESS_RE.test(fromFile)) {
    throw new Error('The sweep file has no valid final wallet. Set it on Admin › USDT Deposits and download the file again.');
  }
  if (local && fromFile !== undefined && local !== fromFile) {
    throw new Error(`The sweep file sends to ${fromFile}, but USDT_TREASURY_ADDRESS here is ${local}. Nothing was sent.`);
  }
  return fromFile ?? local;
}

/** Whether `typed` is the last 6 characters of `address` (any case). */
export function confirmsAddress(address, typed) {
  const want = String(address).toLowerCase().slice(-6);
  return String(typed ?? '').trim().toLowerCase() === want;
}

// ── The chain ────────────────────────────────────────────────────────────────

/** A JSON-RPC caller for `url`. */
export function rpcAt(url) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) throw new Error(`${method}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitForReceipt(rpc, hash, { pollMs = 3000, timeoutMs = 180_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    if (Date.now() > until) throw new Error(`transaction ${hash} was not mined in ${timeoutMs / 1000} s`);
    await sleep(pollMs);
  }
}

/**
 * Sweep every row. With `send` false nothing is signed: each row's plan is
 * logged. `onSwept(orderId, txHash)` is called once a transfer is mined and
 * succeeded. Returns a line per row.
 */
export async function runSweep({ rows, account, treasury, rpc, send = false, log = console.log, onSwept = () => {}, pollMs, timeoutMs }) {
  const to = String(treasury ?? '').toLowerCase();
  if (!ADDRESS_RE.test(to)) throw new Error('The final wallet must be a BSC address: 0x followed by 40 hexadecimal characters.');
  const keyId = keyIdOf(account);
  const gas = gasKey(account);
  const gasAddress = addressOf(gas);
  const out = [];
  for (const row of rows) {
    const line = { orderId: row.orderId, address: row.address };
    out.push(line);
    if (row.keyId !== keyId) {
      Object.assign(line, { status: 'refused', reason: `keyId ${row.keyId} is not this phrase's account (${keyId})` });
      log(`✗ ${row.orderId}: ${line.reason}`); continue;
    }
    if (!Number.isInteger(row.derivationIndex) || row.derivationIndex < 0) {
      Object.assign(line, { status: 'refused', reason: 'no derivation index' });
      log(`✗ ${row.orderId}: ${line.reason}`); continue;
    }
    const key = depositKey(account, row.derivationIndex);
    const derived = addressOf(key);
    if (derived !== deriveDepositAddress(account, row.derivationIndex) || derived !== row.address) {
      Object.assign(line, { status: 'refused', reason: `index ${row.derivationIndex} derives ${derived}, not ${row.address}` });
      log(`✗ ${row.orderId}: ${line.reason}`); continue;
    }
    try {
      const usdtRaw = BigInt(await rpc('eth_call', [{ to: BSC_USDT_CONTRACT, data: balanceOfData(derived) }, 'latest']));
      if (usdtRaw === 0n) {
        Object.assign(line, { status: 'empty' });
        log(`· ${row.orderId}: ${derived} holds no USDT (already swept?)`); continue;
      }
      const data = transferData(to, usdtRaw);
      const gasPrice = BigInt(await rpc('eth_gasPrice'));
      let gasLimit;
      try { gasLimit = (BigInt(await rpc('eth_estimateGas', [{ from: derived, to: BSC_USDT_CONTRACT, data }])) * 12n) / 10n; }
      catch { gasLimit = FALLBACK_TOKEN_GAS; }
      const fee = gasLimit * gasPrice;
      const bnb = BigInt(await rpc('eth_getBalance', [derived, 'latest']));
      const topUp = bnb >= fee ? 0n : fee - bnb;
      const usdtText = `${Number(usdtRaw / 10n ** 12n) / 1e6} USDT`;
      line.usdt = usdtText;
      if (!send) {
        Object.assign(line, { status: 'planned' });
        log(`→ ${row.orderId}: ${usdtText} from ${derived}${topUp ? `, after ${Number(topUp) / 1e18} BNB of gas from ${gasAddress}` : ''}`);
        continue;
      }
      if (topUp > 0n) {
        const nonce = BigInt(await rpc('eth_getTransactionCount', [gasAddress, 'pending']));
        const fund = signLegacyTx({ nonce, gasPrice, gasLimit: BNB_TRANSFER_GAS, to: derived, value: topUp }, gas.privateKey);
        const fundHash = await rpc('eth_sendRawTransaction', [fund]);
        const funded = await waitForReceipt(rpc, fundHash, { pollMs, timeoutMs });
        if (funded.status !== '0x1') throw new Error(`gas top-up ${fundHash} failed`);
      }
      const nonce = BigInt(await rpc('eth_getTransactionCount', [derived, 'pending']));
      const tx = signLegacyTx({ nonce, gasPrice, gasLimit, to: BSC_USDT_CONTRACT, data }, key.privateKey);
      const hash = await rpc('eth_sendRawTransaction', [tx]);
      const receipt = await waitForReceipt(rpc, hash, { pollMs, timeoutMs });
      if (receipt.status !== '0x1') throw new Error(`transfer ${hash} failed on chain`);
      Object.assign(line, { status: 'swept', txHash: hash });
      onSwept(row.orderId, hash);
      log(`✓ ${row.orderId}: ${usdtText} → ${to} (${hash})`);
    } catch (e) {
      Object.assign(line, { status: 'failed', reason: e.message });
      log(`✗ ${row.orderId}: ${e.message}`);
    }
  }
  return out;
}

// ── Command line ─────────────────────────────────────────────────────────────

/**
 * What the server is given for a phrase: its account xpub, the key id every
 * address made from it carries, and its gas wallet. Reads no network.
 */
export function accountSummary(account) {
  return { xpub: account.publicExtendedKey, keyId: keyIdOf(account), gasWallet: addressOf(gasKey(account)) };
}

async function main(argv) {
  if (argv.includes('--xpub')) {
    // For setting up, or rotating to, a phrase: print what goes in
    // USDT_BEP20_XPUB, never the phrase or a private key.
    const a = accountSummary(accountFromSeed(seedFromMnemonic(process.env.USDT_SWEEP_MNEMONIC, process.env.USDT_SWEEP_PASSPHRASE ?? '')));
    console.log(`USDT_BEP20_XPUB=${a.xpub}\nkey id ${a.keyId} · gas wallet ${a.gasWallet}`);
    return 0;
  }
  const send = argv.includes('--send');
  const outAt = argv.indexOf('--out');
  const outFile = resolve(outAt >= 0 ? argv[outAt + 1] : 'usdt-sweep-results.csv');
  const input = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out' && argv[i - 1] !== '--confirm');
  if (!input) {
    console.error('usage: node scripts/usdt-sweep.mjs <usdt-sweep.csv> [--send [--confirm <last 6 of the final wallet>]] [--out results.csv]');
    return 2;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run with NODE_ENV=production: the recovery phrase never goes on a server.');
    return 2;
  }
  const rpcUrl = String(process.env.BSC_RPC_URL ?? '').trim();
  if (!rpcUrl) { console.error('Set BSC_RPC_URL to a BNB Smart Chain node.'); return 2; }
  const account = accountFromSeed(seedFromMnemonic(process.env.USDT_SWEEP_MNEMONIC, process.env.USDT_SWEEP_PASSPHRASE ?? ''));
  const rpc = rpcAt(rpcUrl);
  const chainId = Number(BigInt(await rpc('eth_chainId')));
  if (chainId !== BSC_CHAIN_ID) { console.error(`BSC_RPC_URL is chain ${chainId}, not BNB Smart Chain (${BSC_CHAIN_ID}).`); return 2; }
  const gasAddress = addressOf(gasKey(account));
  const gasBnb = Number(BigInt(await rpc('eth_getBalance', [gasAddress, 'latest']))) / 1e18;
  console.log(`Account ${keyIdOf(account)} · gas wallet ${gasAddress} holds ${gasBnb} BNB · ${send ? 'SENDING' : 'dry run (add --send to sweep)'}`);

  const rows = parseSweepFile(readFileSync(resolve(input), 'utf8'));
  const to = destinationFor(rows, process.env.USDT_TREASURY_ADDRESS);
  console.log(`USDT goes to your final wallet: ${to}`);
  if (send) {
    const confirmAt = argv.indexOf('--confirm');
    let typed = confirmAt >= 0 ? argv[confirmAt + 1] : null;
    if (typed === null && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      typed = await rl.question('Check it is YOUR wallet. Type its last 6 characters to send: ');
      rl.close();
    }
    if (!confirmsAddress(to, typed)) {
      console.error('Not confirmed: nothing was sent. If that is not your wallet, do not sweep; fix it on Admin › USDT Deposits.');
      return 2;
    }
  }
  if (send && !existsSync(outFile)) writeFileSync(outFile, 'orderId,txHash\n');
  const lines = await runSweep({
    rows, account, treasury: to, rpc, send,
    onSwept: (orderId, hash) => appendFileSync(outFile, `${orderId},${hash}\n`),
  });
  const count = (s) => lines.filter((l) => l.status === s).length;
  console.log(`\n${rows.length} lines: ${count(send ? 'swept' : 'planned')} ${send ? 'swept' : 'to sweep'}, ${count('empty')} empty, `
    + `${count('refused')} refused, ${count('failed')} failed.${send ? ` Results: ${outFile}` : ''}`);
  return count('refused') + count('failed') > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}

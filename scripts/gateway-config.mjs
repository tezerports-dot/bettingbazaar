#!/usr/bin/env node
// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * gateway-config.mjs — the OFFLINE tool for the signed gateway document
 * (`backend/domains/configuration/gatewayConfig.js`, CLAUDE.md §2).
 *
 *   node scripts/gateway-config.mjs keygen --out <path outside any git checkout>
 *       Writes a new Ed25519 private key (PKCS#8 PEM, mode 0600, never
 *       overwrites) and prints the public key for VITE_GATEWAY_CONFIG_PUBLIC_KEY
 *       and GATEWAY_CONFIG_PUBLIC_KEY.
 *
 *   node scripts/gateway-config.mjs sign --key <path> --version <n>
 *       --hosts a.example.com,b.example.com (--expires <ISO instant> | --days <n>)
 *       [--out <file>]
 *       Signs a document issued now and prints it (or writes it to --out).
 *
 *   node scripts/gateway-config.mjs verify --public-key <base64url> [--floor <n>] <file>
 *       Verifies a document as the app would; exits 1 with the reason if not.
 *
 * The private key is refused anywhere inside a git checkout, so it cannot be
 * committed by accident. Keep it offline; the servers never hold it.
 */
import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATEWAY_FORMAT, rawPublicKey, signGatewayPayload, verifyGatewayDocument,
} from '../backend/domains/configuration/gatewayConfig.js';

const DAY_MS = 86_400_000;

function fail(message) {
  return Object.assign(new Error(message), { cli: true });
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw fail(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i += 1;
    } else positional.push(arg);
  }
  return { flags, positional };
}

/** The git checkout containing `path` (or its nearest existing parent), or ''. */
function checkoutOf(path) {
  let dir = dirname(resolve(path));
  while (!existsSync(dir)) dir = dirname(dir);
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

const thisRepo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A private key path must be outside this repository and outside any git checkout. */
function assertOutsideRepo(path) {
  const full = resolve(path);
  const checkout = checkoutOf(full);
  if (full === thisRepo || full.startsWith(`${thisRepo}/`) || checkout) {
    throw fail(`refusing a private key inside a git checkout (${checkout || thisRepo}); keep it offline, outside any repository`);
  }
}

function keygen({ flags }, out) {
  if (!flags.out) throw fail('keygen needs --out <path>');
  assertOutsideRepo(flags.out);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  try {
    writeFileSync(resolve(flags.out), pem, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw fail(`${flags.out} exists; a key is never overwritten`);
    throw err;
  }
  out(`private key written to ${resolve(flags.out)} (keep it offline)`);
  out(`public key: ${rawPublicKey(privateKey)}`);
}

function sign({ flags }, out, now) {
  if (!flags.key) throw fail('sign needs --key <path>');
  assertOutsideRepo(flags.key);
  const version = Number(flags.version);
  if (!flags.version || !Number.isSafeInteger(version)) throw fail('sign needs --version <integer>, higher than the last one signed');
  if (!flags.hosts) throw fail('sign needs --hosts a.example.com,b.example.com');
  if (Boolean(flags.expires) === Boolean(flags.days)) throw fail('sign needs exactly one of --expires <ISO instant> or --days <n>');
  const issued = new Date(now);
  const expires = flags.expires ? new Date(flags.expires) : new Date(now + Number(flags.days) * DAY_MS);
  if (!Number.isFinite(expires.getTime())) throw fail('--expires / --days does not give a time');

  const privateKey = createPrivateKey(readFileSync(resolve(flags.key), 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw fail(`${flags.key} is not an Ed25519 private key`);
  const document = signGatewayPayload({
    format: GATEWAY_FORMAT,
    version,
    issuedAt: issued.toISOString(),
    expiresAt: expires.toISOString(),
    hosts: flags.hosts.split(',').map((h) => h.trim()).filter(Boolean),
  }, privateKey);
  // Prove it verifies as the app will verify it before anyone ships it.
  verifyGatewayDocument(document, rawPublicKey(privateKey), { now });

  const text = `${JSON.stringify(document)}\n`;
  if (flags.out) {
    writeFileSync(resolve(flags.out), text);
    out(`signed version ${version} written to ${resolve(flags.out)}`);
  } else out(text.trimEnd());
}

function verifyCmd({ flags, positional }, out, now) {
  if (!flags['public-key']) throw fail('verify needs --public-key <base64url>');
  if (positional.length !== 1) throw fail('verify needs one document file');
  const floor = flags.floor === undefined ? 0 : Number(flags.floor);
  if (!Number.isSafeInteger(floor) || floor < 0) throw fail('--floor must be a whole number');
  const payload = verifyGatewayDocument(readFileSync(resolve(positional[0]), 'utf8'), flags['public-key'], { now, floor });
  out(`valid: version ${payload.version}, expires ${payload.expiresAt}, hosts ${payload.hosts.join(', ')}`);
}

/** Run one command. Returns the exit code; `out`/`err` receive lines. */
export function main(argv, { out = console.log, err = console.error, now = Date.now() } = {}) {
  const [command, ...rest] = argv;
  try {
    const args = parseArgs(rest);
    if (command === 'keygen') keygen(args, out);
    else if (command === 'sign') sign(args, out, now);
    else if (command === 'verify') verifyCmd(args, out, now);
    else throw fail('usage: gateway-config.mjs keygen | sign | verify (see the header of scripts/gateway-config.mjs)');
    return 0;
  } catch (e) {
    err(`gateway-config: ${e.code ? `${e.code}: ` : ''}${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

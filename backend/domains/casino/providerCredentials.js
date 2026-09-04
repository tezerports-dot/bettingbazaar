// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * domains/casino/providerCredentials.js — sealing and opening game-provider
 * credentials.
 *
 * ── Why these are encrypted at rest ─────────────────────────────────────────
 * A provider API secret is the authority to act as this operator against a game
 * supplier: to open sessions, to be told balances, and — for suppliers whose
 * wallet API is bidirectional — to move money. A database dump containing them
 * in plaintext hands that authority to whoever holds the dump, and no amount of
 * masking in an admin screen changes what is on the disk.
 *
 * The columns are named `*_encrypted` and `getProviderSecrets()` returns them
 * under those names, so a caller cannot mistake ciphertext for a usable key: it
 * has to come through this module to get one. That naming is load-bearing —
 * the launch handler previously signed HMACs with the value straight out of the
 * column, which would have produced a signature every provider rejected.
 *
 * ── Where the boundary sits ─────────────────────────────────────────────────
 * The `database/` folder stores and returns ciphertext and never holds a key.
 * Encryption keys are an application concern (rotation, env, boot checks), so
 * the seal and the open live here, beside the only code that calls a provider.
 * That also means a query run against the database directly — by a report, a
 * console, or an attacker with read access — yields nothing usable.
 */
import { encryptField, decryptField, configured } from '../identity/fieldCrypto.util.js';

export { configured as credentialCryptoConfigured };

/**
 * Seal a credential for storage.
 *
 * `null`/`undefined` pass through as null, which the repository reads as
 * "unchanged" on an update and "absent" on a create — an admin editing a
 * provider's description must not have to re-type its API secret. An empty
 * string is NOT sealed: it is the deliberate "clear this credential" signal and
 * reaches the column as null.
 */
export function sealCredential(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  return encryptField(String(plain));
}

/**
 * Open a sealed credential. Returns null for an unset one.
 *
 * Throws when the ciphertext does not authenticate — a wrong key or a tampered
 * row. That is deliberate: a launch signed with a silently-wrong secret fails
 * at the provider with an opaque error hours later, while a throw here names
 * the problem at the moment it happens.
 */
export function openCredential(sealed) {
  if (sealed === null || sealed === undefined || sealed === '') return null;
  return decryptField(sealed);
}

/**
 * The plaintext credentials for one provider, from the row's sealed columns.
 *
 * Returns the same shape the launch and webhook handlers used to build by hand,
 * so there is one place that knows which column holds which secret.
 *
 * @param {object|null} secrets the object `db.games.getProviderSecrets()` returns
 * @returns {{apiUrl:string|null, apiKey:string|null, apiSecret:string|null,
 *            webhookSecret:string|null, merchantId:string|null, extraConfig:object}|null}
 */
export function openProviderSecrets(secrets) {
  if (!secrets) return null;
  return {
    providerKey:   secrets.providerKey,
    apiUrl:        secrets.apiUrl,
    apiKey:        openCredential(secrets.apiKeyEncrypted),
    apiSecret:     openCredential(secrets.apiSecretEncrypted),
    webhookSecret: openCredential(secrets.webhookSecretEncrypted),
    merchantId:    secrets.merchantId,
    extraConfig:   secrets.extraConfig ?? {},
  };
}

export default { sealCredential, openCredential, openProviderSecrets };

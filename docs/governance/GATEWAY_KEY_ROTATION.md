# Gateway signing key runbook

How to generate, store and back up the Ed25519 key that signs the gateway config, how to sign and publish a new config, and what to do if the key is lost or leaked. Rules live in `CLAUDE.md` §2 ("The API host player apps are sent to"); this file is procedure.

One offline Ed25519 key is the only thing that can move installed player apps to a new API host. Losing it is recoverable only through an app update. Leaking it lets an attacker who can also put a document in front of apps (a server's document file, a mirror, or the network path to a mirror) redirect them. Check the Gaps section against the code before relying on the leak steps.

Code: `scripts/gateway-config.mjs`, `backend/domains/configuration/gatewayConfig.js`, `backend/routes/clientEndpoint.routes.js`, `user-panel/src/services/gatewayConfig.ts`, `user-panel/src/services/originFailover.ts`.

## How trust works

The app adopts a host only from a document whose signature verifies against the public key baked into that build. Servers, mirrors and the network can withhold a document but cannot forge one.

| Piece | Where it lives | Role |
| --- | --- | --- |
| Private key (PKCS#8 PEM) | Offline only, never a server, CI or the repo | Signs documents |
| `VITE_GATEWAY_CONFIG_PUBLIC_KEY` | Each app build (base64url, 32 bytes) | The trust decision |
| `GATEWAY_CONFIG_PUBLIC_KEY` | Server env | The server refuses to serve a document that does not verify now; convenience only |
| `GATEWAY_CONFIG_FILE` | Server env, a path on each API server | The signed document that server serves |
| `GET /api/v1/client/gateway-config` | Every API server, public, 60 s cache | Serves that file as signed; 404 when unset, expired or not verifying |
| `VITE_GATEWAY_CONFIG_URLS` | Each app build | HTTPS mirrors of the document (static host or CDN off the API hosts) |

Each document is `{"payload": "<base64url JSON>", "signature": "<base64url>"}`. The payload carries format `bb-gateway-config/1`, a version, issuedAt, expiresAt and 1 to 8 plain lowercase hostnames, and may live at most 400 days.

The app:

- refuses a version lower than the highest it has accepted **under the same public key** (the floor and the stored document are keyed by the key, so a different key starts its own count);
- refuses an expired document, and one issued more than a day ahead of the phone's clock;
- remembers the last verified document and re-verifies it at every launch, so a dead mirror still leaves it its signed hosts;
- tries signed hosts after its build-time ones (primary, backup, `VITE_API_ALLOWED_HOSTS`); when none answers at launch it fetches the document from the mirrors and probes any host it newly names;
- after it connects, asks the mirrors and the connected server's `/api/v1/client/gateway-config` for a newer document, in the background.

With no valid document it uses only the build-time `VITE_API_URL`, `VITE_API_BACKUP_URL` and `VITE_API_ALLOWED_HOSTS`.

## Generate, store and back up the key

Generate two keys, a primary and a standby, on a machine you trust (not a server, not CI).

1. From a repo checkout, run `npm run gateway-config -- keygen --out /path/outside/repo/gateway-primary.pem`. The tool refuses a path inside any git checkout, refuses to overwrite, writes the file with mode 0600, and prints the public key.
2. Repeat for `gateway-standby.pem`. Each build trusts only one key (Gaps, item 1), so the standby is useful only once two-key support exists, but generating it now costs nothing.
3. Set the primary public key as `VITE_GATEWAY_CONFIG_PUBLIC_KEY` in the app build secrets and `GATEWAY_CONFIG_PUBLIC_KEY` on every API server. Public keys are not secret; record both in the deployment notes.
4. The PEM is written unencrypted. Move it straight into encrypted storage (a password manager file vault, or an `age` or `gpg` encrypted file) and delete the plaintext with `shred -u`.
5. Keep two copies in different places, for example the password manager and an encrypted USB drive in a safe. Treat them like the Android keystore: off the box, never in git, chat or email.
6. Write down who holds each copy and how to reach them. Do a restore drill: decrypt each copy, sign a throwaway document to a local file, and check it with `npm run gateway-config -- verify --public-key <the build's key> <file>`. Do not publish it.

## Sign and publish a new config

Do this whenever hosts change, and at least 3 weeks before the live document expires.

1. Check the live document's version and expiry: `curl -s https://<api host>/api/v1/client/gateway-config > live.json` then `npm run gateway-config -- verify --public-key <the build's key> live.json`.
2. On the offline machine, decrypt the key and run `npm run gateway-config -- sign --key <pem> --version <current + 1> --hosts api1.example.com,api2.example.net --days 90 --out gateway-vN.json`. Hosts are plain lowercase hostnames, up to 8, no scheme, port, path or IP. Give exactly one of `--days <n>` or `--expires <ISO instant>`; the lifetime may not exceed 400 days. The tool verifies its own output before writing it.
3. Run `npm run gateway-config -- verify --public-key <the build's key> --floor <current> gateway-vN.json`. It prints the version, expiry and hosts.
4. Re-encrypt or shred the decrypted key.
5. Copy the file to the `GATEWAY_CONFIG_FILE` path on every API server. Each server re-reads it within 60 seconds and serves it only if it verifies.
6. Copy the same bytes to every `VITE_GATEWAY_CONFIG_URLS` mirror.
7. Apps pick it up on their next launch or connection, within the 60 second cache. Confirm with `curl` on a server and on each mirror.

Never reuse or skip back a version number. Versions only rise, and an install refuses a second document under a version it already holds.

## Planned rotation

With one trusted key per build, rotation is a cutover: installs on the old build stop receiving host changes the moment the servers and mirrors switch keys. The steps below keep them working on their last signed hosts until they update.

1. Ship an app build with the new public key in `VITE_GATEWAY_CONFIG_PUBLIC_KEY`. The web panel switches on reload; APK installs switch only when they install the update.
2. While the servers still hold the old key, publish a final old-key document (version N) with the hosts you expect to keep, and a long expiry (up to 400 days).
3. Wait until most installs have fetched version N. Each install remembers it.
4. Set `GATEWAY_CONFIG_PUBLIC_KEY` on the servers to the new key, then publish a new-key document. Keep numbering upward (N+1); installs hold a separate floor per key, so this is for your records, not a requirement.
5. Old builds now fail to verify the new document and keep their remembered version N until it expires, then fall back to their build-time origins. New builds use the new document.
6. Keep the old private key until version N has expired, then destroy every copy.

Any host you retire before version N expires stays in use by old installs. Keep those hosts serving until then.

## Key lost

If every copy of the private key is gone, no new document can be signed for any existing install. Nothing breaks at once: apps keep the last document they verified until it expires, then fall back to the build-time `VITE_API_URL`, `VITE_API_BACKUP_URL` and `VITE_API_ALLOWED_HOSTS`.

1. Keep every host in the current document serving. You can no longer move apps off them.
2. Generate a new key and ship an app build with its public key. Set it on the servers and publish a new-key document.
3. Push the update hard (in-app update prompt, Telegram announcement). Installs that never update are pinned to the old document's hosts until its expiry, then to their build-time origins.
4. If any of those hosts must go away before then, the only lever is DNS and TLS for that hostname, not the gateway config.

The cheapest prevention is the second backup copy and the restore drill above, plus two-key support (Gaps, item 1).

## Key leaked

A leaked key alone moves no one: the attacker still has to get their document in front of apps, through an API server's document file, a mirror, or the network path to a mirror. A leak plus any of those lets them point every install that fetches it at their own server, where players would send logins and money requests.

Act in this order:

1. **Hold the channel.** Lock down the API servers (the `GATEWAY_CONFIG_FILE` path) and every mirror. Check each served document's version and hosts with `verify` for ones you did not publish.
2. **Publish a clean document now** with a version well above anything seen, signed with the leaked key, so installs that have not yet seen a bad document move to your hosts. This buys time; it does not end the exposure.
3. **Rotate.** Ship a build with a new key, set it on the servers, and publish a new-key document. Treat the new build as a forced update. A malicious old-key document cannot block it: the new key's floor starts fresh, and a malicious document lives at most 400 days.
4. **Assume old builds are lost** until updated: the attacker can keep signing for them for as long as they can reach a server's file, a mirror or the path to one.

## Gaps

Found reviewing the original design. Remove any row the code now addresses.

| # | Gap | Effect | Suggested fix |
| --- | --- | --- | --- |
| 1 | Each build trusts exactly one key; the server checks one key | No standby to fall back to; rotation strands old installs (Planned rotation) | Accept a list (`VITE_GATEWAY_CONFIG_PUBLIC_KEYS`), ship primary and standby in every build |
| 4 | `keygen` writes an unencrypted PEM | A copied laptop or backup leaks the key | Passphrase-protect the PEM, or pipe straight into `age` |
| 5 | Each server and mirror serves one document | Old-key and new-key builds cannot both get fresh hosts during rotation | Multi-signature envelope, or one document per key id |
| 6 | No way to tell an old build to distrust a key | Leak response depends on users updating | Signed revocation list, or a minimum-build check that forces the update |
| 7 | No automated expiry monitoring | A missed renewal silently drops every install to build-time origins | A weekly check that runs `verify` on the live document and flags expiry within 21 days |

Items 2 (version floor with no ceiling, not tied to a key) and 3 (no issuedAt or lifetime check in the app) are fixed: the app holds its floor per public key, and refuses a document issued over a day ahead of its clock or meant to live over 400 days (`gatewayConfig.ts`, mirrored in `gatewayConfig.js`).

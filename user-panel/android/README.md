# Betting Bazaar — native Android app

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

A Capacitor 8 shell around the user panel. The web assets are **bundled into the
package** (`webDir: dist`), so the app opens without a network round-trip. Only
the API is remote.

This is generated output that is *committed on purpose* — the manifest, the
signing configuration, the network policy and the Gradle wrapper are all edited
here, and regenerating the folder would discard them. Do not delete and re-add
the platform to "refresh" it; run `npx cap sync android` instead.

## Building

```bash
cd user-panel

# Web bundle for the native shell. VITE_API_URL is MANDATORY — see below.
VITE_API_URL=https://api.yourdomain.com npm run android:sync

# Then either open Android Studio…
npm run android:open
# …or build from the CLI (requires the Android SDK):
cd android && ./gradlew assembleDebug
```

### `VITE_API_URL` is not optional

Inside the shell `window.location` is `https://localhost`, so
`src/services/realBackend.ts` matches its `isLocal` branch and resolves the API
to `http://localhost:8080/api` — **the handset itself**. Nothing throws. The APK
installs, opens, renders the shell, and every request fails.

`npm run build:native` runs `scripts/assert-native-env.mjs` first and refuses to
build without an absolute `https` origin. It also rejects `localhost` and a
trailing `/api` (which `realBackend.ts` appends itself, producing `/api/api/…`).

## Releases

Built by `.github/workflows/android-release.yml`, not locally — the signing key
belongs in repository secrets, not on a laptop, and `versionCode` is derived
from the workflow run number because Play permanently rejects a `versionCode` it
has already accepted.

Trigger with the **Android release** workflow (supply a version name) or by
pushing an `android-v*` tag.

### Required configuration

| Kind | Name | Purpose |
|---|---|---|
| Secret | `ANDROID_KEYSTORE_BASE64` | Upload keystore, base64-encoded |
| Secret | `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| Secret | `ANDROID_KEY_ALIAS` | Key alias inside the keystore |
| Secret | `ANDROID_KEY_PASSWORD` | Key password |
| Variable | `ANDROID_API_URL` | Absolute API origin, e.g. `https://api.yourdomain.com` |
| Variable | `ANDROID_MERCHANT_PANEL_URL` | Merchant panel origin, if separately deployed |

Create the upload keystore once and **back it up somewhere you will still have
in five years**. Losing it means you can never ship an update to the installed
app again — Play identifies an app by its signing key, and a new key is a new
app. (Play App Signing mitigates this; enrol if you have not.)

```bash
keytool -genkeypair -v -keystore upload-keystore.jks \
  -keyalg RSA -keysize 4096 -validity 10000 -alias upload
base64 -w0 upload-keystore.jks   # → ANDROID_KEYSTORE_BASE64
```

The workflow verifies the finished APK carries this key and fails if it is
debug-signed — a debug-signed build installs fine on a test handset and is only
rejected at upload time, which is far too late to discover.

## Deliberate configuration

| Setting | Value | Why |
|---|---|---|
| `allowBackup` / `dataExtractionRules` | disabled | The default copies WebView storage — holding the live session token — into the user's Google Drive, and clones a logged-in session on device transfer. |
| `usesCleartextTraffic` + `network_security_config` | TLS only | Enforced by the OS, so app code cannot weaken it. |
| `androidScheme` | `https` | A secure context is required for `crypto.subtle` and the storage APIs the auth layer uses. |
| Service worker | not registered | `src/index.tsx` detects the native shell and skips it — the WebView already resolves these assets locally, and the app updates through the Play Store. |
| R8 / `minifyEnabled` | **off** | Capacitor resolves plugins reflectively; shrinking needs exactly-right keep rules or the build compiles and fails on hardware. The payoff on a WebView app is small. Keep rules are written in `app/proguard-rules.pro` — turning it on is one line plus a **device smoke test**. |

## No bundled VPN or proxy

Deliberate, and recorded in `docs/governance/04-GOVERNANCE.md` §20. Resilience
against a blocked or failing origin is handled where it belongs — multi-domain
redundancy, an Anycast/CDN edge, and client-side domain failover — not by
tunnelling user traffic from inside a real-money gambling client.

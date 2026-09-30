# Betting Bazaar — native Android app

<!-- GOVERNANCE: Read CLAUDE.md before editing this file. -->

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

## Releases, and how installed apps update

The whole loop — the signing key (one script, in a Codespace), the server
settings, building with the **Android release** workflow, publishing on the
admin **Android App** page, and what players see — is in
[`docs/governance/ANDROID_RELEASE_SETUP.md`](../../docs/governance/ANDROID_RELEASE_SETUP.md).

In short: bump `user-panel/package.json`, run the workflow, upload
`app-release.apk` on the admin page, publish. Installed apps find it on their
own, download it inside the app, verify its SHA-256, and open Android's
installer (`ApkUpdaterPlugin.java`). A release marked **mandatory** blocks every
older install until it updates.

The versionName is package.json's version and nothing else — it is the number
the bundle reports — and the versionCode is the workflow run number, which
only increases (Android refuses a lower one).

## Icons and splash

Generated, never hand-edited: `npm run icons:generate` writes the launcher
icons, the adaptive-icon foreground, every splash density and the brand
background colour from the same mark the web app uses. `--check` (run by
`nativeBrand.test.ts` on every CI run) fails if a committed file differs.

## Deliberate configuration

| Setting | Value | Why |
|---|---|---|
| `allowBackup` / `dataExtractionRules` | disabled | The default copies WebView storage — holding the live session token — into the user's Google Drive, and clones a logged-in session on device transfer. |
| `usesCleartextTraffic` + `network_security_config` | TLS only | Enforced by the OS, so app code cannot weaken it. |
| `androidScheme` | `https` | A secure context is required for `crypto.subtle` and the storage APIs the auth layer uses. |
| `REQUEST_INSTALL_PACKAGES` | declared | The in-app updater hands a verified APK to Android's installer. Google Play forbids it — a Play build removes it with the plugin. |
| Service worker | not registered | `src/index.tsx` detects the native shell and skips it — the WebView already resolves these assets locally, and the app updates through the Play Store. |
| R8 / `minifyEnabled` | **off** | Capacitor resolves plugins reflectively; shrinking needs exactly-right keep rules or the build compiles and fails on hardware. The payoff on a WebView app is small. Keep rules are written in `app/proguard-rules.pro` — turning it on is one line plus a **device smoke test**. |

## No bundled VPN or proxy

Deliberate, and recorded in `CLAUDE.md` §20. Resilience
against a blocked or failing origin is handled where it belongs — multi-domain
redundancy, an Anycast/CDN edge, and client-side domain failover — not by
tunnelling user traffic from inside a real-money gambling client.

# Android app: key, build, publish, update

<!-- GOVERNANCE: Read CLAUDE.md before editing this file. It is reference, never rules. -->

The player panel ships as a **native Android app** (Capacitor): the whole UI is
inside the APK, only the API is remote, and the app **updates itself** from
releases you publish on the admin panel's **Android App** page.

This guide covers the one-time setup, then the loop you repeat for every release.

| Once | Every release |
|---|---|
| §1 Make the signing key (Codespace, one script) | §4 Bump the version in `user-panel/package.json`, merge |
| §2 Configure the server | §5 Run the **Android release** workflow |
| §3 Configure Cloudflare Turnstile for the app | §6 Upload the APK on **Android App**, write notes, publish |

> **Read `NATIVE_APP_DISTRIBUTION_POLICY.md` §1 before you distribute to
> anyone.** India's Promotion and Regulation of Online Gaming Act, 2025 has been
> in force since 1 May 2026 and prohibits offering online money games; a
> sideloaded APK does not change that. The engineering here is worth having
> either way, but distribution is a legal decision, not a technical one.

---

## 1. Make the signing key — in a GitHub Codespace

The signing key IS the app's identity on every phone. Every update must be
signed with the same key, or Android refuses it. **Lose it and no installed
copy can ever update again.** So it is made once, backed up twice, and never
committed.

Open a Codespace on this repository (**Code → Codespaces → Create codespace on
`main`**), then in its terminal:

```bash
bash scripts/android/create-signing-key.sh
```

It will:

1. Check for `keytool` (a JDK). If it is missing it prints the one command to
   install it: `sudo apt-get update && sudo apt-get install -y openjdk-21-jdk-headless`.
2. Sign you in to GitHub with **your** account. A Codespace's built-in token can
   read the repository but cannot write its secrets, so it opens a browser code
   the first time.
3. Refuse to overwrite a key that already exists — locally, or in GitHub
   (unless you type `REPLACE`, which strands every installed copy).
4. Create a 4096-bit RSA key, valid ~27 years, with a random 32-character password.
5. Write a backup note and **stop until you type `SAVED`**. Open it with the
   `code …` command it prints, copy all of it into your password manager as a
   secure note, and save it in one more place you control.
6. Set the four repository **secrets** the release workflow reads:
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
   `ANDROID_KEY_PASSWORD`.
7. Ask for two origins and set them as repository **variables**:
   - `ANDROID_API_URL`, your backend, e.g. `https://api.yourdomain.com` (no `/api`)
   - `ANDROID_APP_ORIGIN`, your public site, the same value as the backend's
     `PUBLIC_APP_ORIGIN`, e.g. `https://yourdomain.com`
8. Print the three backend lines for §2, including your key's fingerprint.
9. Offer to shred the local copies. Say yes, then delete the Codespace if you
   made it only for this.

If you prefer to type it yourself, the script is equivalent to:

```bash
mkdir -p ~/bettingbazaar-signing && cd ~/bettingbazaar-signing && chmod 700 .
export KS_PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)"; echo "$KS_PASS"   # save it
keytool -genkeypair -v -keystore upload-keystore.jks -storetype PKCS12 \
  -alias bettingbazaar-upload -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Betting Bazaar, O=Betting Bazaar, C=IN" -storepass:env KS_PASS -keypass:env KS_PASS
keytool -list -v -keystore upload-keystore.jks -storepass:env KS_PASS | grep SHA256:   # the fingerprint

unset GITHUB_TOKEN; gh auth login -s repo          # your account, not the Codespace token
R=tezerports-dot/bettingbazaar
base64 -w0 upload-keystore.jks | gh secret set ANDROID_KEYSTORE_BASE64 -R $R
printf %s "$KS_PASS"             | gh secret set ANDROID_KEYSTORE_PASSWORD -R $R
printf %s bettingbazaar-upload   | gh secret set ANDROID_KEY_ALIAS -R $R
printf %s "$KS_PASS"             | gh secret set ANDROID_KEY_PASSWORD -R $R
gh variable set ANDROID_API_URL    -R $R --body https://api.yourdomain.com
gh variable set ANDROID_APP_ORIGIN -R $R --body https://yourdomain.com
```

(`-w0` matters: without it `base64` wraps lines and the secret is corrupt.)

**Verified, 2026-09-30:** with a stand-in for `gh`, both the secret and the
backup note decode to the exact keystore. An APK signed through the release
workflow's own signing path with that key carries the fingerprint the script
printed, and the real upload route accepted it (201). What was *not* run is a
real GitHub write: no repository credentials exist here.

---

## 2. Configure the server

In the backend's environment (`deploy/vps/.env`, section 6c):

| Variable | Value | Why |
|---|---|---|
| `ANDROID_PACKAGE_ID` | `com.bettingbazaar.app` | Every uploaded APK is checked against it; `assetlinks.json` names it |
| `ANDROID_SHA256_CERT_FINGERPRINTS` | the `SHA256:` value the script printed | Uploads signed with any other key are refused; reset links open the app |
| `ALLOWED_ORIGINS` | your origins **plus `https://localhost`** | The app runs at `https://localhost` inside the phone. Without it, CORS refuses every request the app makes. Production refuses to boot with `ANDROID_PACKAGE_ID` set and this missing. |

S3/CDN storage must be configured (production requires it anyway): uploaded APKs
are stored there, one immutable object per version.

If nginx fronts the API, it needs the scoped `client_max_body_size 150m` block for
`/api/admin/android/releases` from `deploy/VPS_UBUNTU_SETUP.md`. Otherwise
uploads above 10 MB answer 413. Caddy has no default limit.

Check the association file is live:

```bash
curl -s https://yourdomain.com/.well-known/assetlinks.json
```

A 404 means the two Android variables are not set.

The admin **Android App** page shows these same checks, green or yellow, at
the top.

---

## 3. Cloudflare Turnstile inside the app

The signup and login captcha runs inside the app's WebView, whose hostname is
`localhost`. In the Cloudflare dashboard, open the Turnstile widget and add
**`localhost`** to its hostnames. Without it the widget answers error 110200,
the server receives no token, and nobody can sign up or log in from the app.

**Not verified here:** there is no Turnstile key in this repository. Community
reports say `localhost` works for Android (it fails for iOS's `capacitor://`
scheme, which does not apply). Confirm it on a phone as part of §7.

---

## 4–6. Every release

1. **Bump the version** in `user-panel/package.json` (e.g. `4.0.0` → `4.1.0`) and
   merge. This is the version players see, and the one the app reports. The
   release workflow reads it and refuses a tag that disagrees. Do not type a
   version anywhere else.
2. **Build:** GitHub → **Actions → Android release → Run workflow** (or push a
   tag `android-v4.1.0`). About 5–10 minutes. It verifies the APK is signed
   with your key, not the debug key, and uploads `app-release.apk` (to sideload
   and upload) and `app-release.aab` (only for the Play Store) as a workflow
   artifact.
3. **Publish:** admin panel → **Android App** → drop in `app-release.apk`.
   - The server reads the version and signing key **from the file** and
     refuses, by name: a different app, a debug build, a different key than
     the one players have installed, or a version not newer than what is
     published.
   - It is saved as a **draft**. Write *What's new*, tick **Mandatory** if older
     versions must stop working (security fixes, server changes the old app
     cannot handle), then **Publish**.

### What players see

| Installed version is… | The app shows |
|---|---|
| below the newest **mandatory** release | A full-screen **Update required**. Nothing else works until they update. |
| below the newest release, but not below a mandatory one | **Update available** with *Later* (asked again after a day, or at once when a newer version is published) |
| the newest | nothing |

It checks when the app opens, every time it comes back to the foreground, and
every 30 minutes. **Update now** downloads inside the app with a progress bar,
verifies the file's SHA-256 against the one the server published, and opens
Android's installer.

- **The first time**, Android asks the player to allow this app to "install
  unknown apps". The app explains this, opens that exact switch, and carries on
  by itself when they come back.
- **After that** it is one tap on Android's **Install**. No app can skip that
  tap on a phone it does not manage.

A published release is never deleted, because players may have it. Fix a bad
release by publishing a newer one.

The **Share & Get the App** menu item and `/api/download/android` always point
at the newest published release.

### The web app is separate

System Settings → *Minimum/Latest Web Version* gates browsers only. A reload
fetches new web code, but it cannot update an APK, whose code is inside the
package. So that gate stands aside inside the app, and the Android App page
governs installs.

---

## Logo and splash

| What | Where it comes from | Change it by |
|---|---|---|
| Launcher icon, Android launch screen | Compiled into the APK from `scripts/generate-icons.mjs` (the gold mark on the brand's dark background) | Editing the generator and building a new release. Android cannot change a launcher icon at runtime. |
| Loading screen logo, update screen, share modal | Branding logo, else App Assets `logo.png`, else the built-in mark | Admin → Branding or App Assets. Live, no build. |
| Loading splash (full screen, after the launch screen) | App Assets `splash.png`, 1242×2688 | Admin → App Assets. Live, no build. Empty shows the logo. |

---

## 7. Check it on a real phone

No APK has ever been run on hardware: the build machine has no emulator. Before
you hand it to anyone:

1. **Install:** transfer `app-release.apk` and tap it, or run
   `adb install -r app-release.apk`.
2. **It reaches the backend:** the app opens past the loading screen. A spinner
   that never ends means `ANDROID_API_URL` is wrong, or `https://localhost` is
   missing from `ALLOWED_ORIGINS`.
3. **Sign up and log in:** the captcha passes (§3) and the Telegram
   verification gate appears.
4. **Links open Telegram:** the bot and channel buttons hand off to the
   Telegram app. `upi://` payment links open a UPI app.
5. **A reset link opens the app:** use "Forgot password" in the bot and tap the
   link. It should open the app's reset screen. If a browser opens instead,
   check `curl https://yourdomain.com/.well-known/assetlinks.json` and
   `adb shell pm get-app-links com.bettingbazaar.app` (you want `verified`). The
   reset still works in the browser either way.
6. **In-app update:**
   - Bump the version, build, upload, publish.
   - Reopen the installed app: **Update available** should appear.
   - Tap **Update now**, allow installs once, tap **Install**. The app reopens on
     the new version.
   - Repeat with **Mandatory** ticked: the old version must be blocked.
7. **Resume:** background the app for a minute and come back. The live cycle
   data resumes.

**A debug build can never update to a release build, or the reverse.** They
are signed with different keys and Android refuses the update. Test updates
between two builds from the release workflow. Uninstall any debug build first.

---

## If you ever publish on Google Play

Play forbids apps it distributes from installing their own updates (Play
updates them), so a Play build must drop the `REQUEST_INSTALL_PACKAGES`
permission and the in-app updater together. Enrol in **Play App Signing** at
first upload. Then add Play's signing fingerprint (Play Console → Setup → App
signing) to `ANDROID_SHA256_CERT_FINGERPRINTS` beside yours, because the
certificate on a Play install is Google's, not yours.

#!/usr/bin/env bash
# GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
#
# Create the Android release signing key and hand it to GitHub — once.
#
# Run it in a GitHub Codespace (or any Linux/macOS terminal with a JDK and gh):
#
#     bash scripts/android/create-signing-key.sh
#
# What it does, in order, stopping at the first problem:
#   1. makes a 4096-bit RSA upload key in ~/bettingbazaar-signing (OUTSIDE the
#      repository, so it can never be committed), with a random password
#   2. sets the four repository SECRETS the "Android release" workflow reads
#   3. sets the two repository VARIABLES the build needs (API + site origin)
#   4. prints the key's SHA-256 for the backend's ANDROID_SHA256_CERT_FINGERPRINTS
#   5. writes a one-page backup note, then offers to shred the local copies
#
# ── Why this key matters more than anything else in the repository ─────────
# Android identifies an app by the key that signed it. Every update must be
# signed with the SAME key or the phone refuses it. Lose this key and no
# installed copy can ever be updated again — every player has to uninstall and
# reinstall. So the script refuses to overwrite a key, refuses to replace the
# one GitHub already holds unless you type REPLACE, and does not finish until
# you have saved the backup.
set -euo pipefail

REPO="${REPO:-tezerports-dot/bettingbazaar}"
DIR="${SIGNING_DIR:-$HOME/bettingbazaar-signing}"
ALIAS="bettingbazaar-upload"
KEYSTORE="$DIR/upload-keystore.jks"
BACKUP="$DIR/BACKUP-bettingbazaar-android-signing.txt"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }

# ── 0. Tools ────────────────────────────────────────────────────────────────
command -v keytool >/dev/null || die "keytool (a JDK) is missing. In a Codespace run:
    sudo apt-get update && sudo apt-get install -y openjdk-21-jdk-headless
then run this script again."
command -v gh >/dev/null || die "The GitHub CLI (gh) is missing: https://cli.github.com"
command -v openssl >/dev/null || die "openssl is missing."
b64() { if base64 --help 2>&1 | grep -q -- '-w'; then base64 -w0 "$1"; else base64 -i "$1" | tr -d '\n'; fi; }

# A Codespace injects a GITHUB_TOKEN that can read the repository but cannot
# write its secrets (it answers 403). Use your own login instead.
GH() { env -u GITHUB_TOKEN gh "$@"; }
if ! GH auth status >/dev/null 2>&1; then
  bold "Sign in to GitHub (a browser code is shown; this is your own account, not the Codespace's token):"
  GH auth login --hostname github.com --git-protocol https --web --scopes repo
fi
GH secret list -R "$REPO" >/dev/null 2>&1 || die "Your GitHub login cannot manage secrets on $REPO. You need admin access to the repository."
ok "GitHub access to $REPO"

# ── 1. Refuse to destroy a key ──────────────────────────────────────────────
[ -e "$KEYSTORE" ] && die "$KEYSTORE already exists. This script never overwrites a signing key.
If you really mean to start over, move it somewhere safe first."

if GH secret list -R "$REPO" | grep -q '^ANDROID_KEYSTORE_BASE64'; then
  bold "GitHub already holds an Android signing key for $REPO."
  echo "Replacing it means every copy of the app players have installed can NEVER update again."
  read -r -p "Type REPLACE to create a new key anyway, anything else to stop: " answer
  [ "$answer" = "REPLACE" ] || die "Stopped. Nothing was changed."
fi

# ── 2. Make the key ─────────────────────────────────────────────────────────
mkdir -p "$DIR" && chmod 700 "$DIR"
read -r -p "Name on the certificate [Betting Bazaar]: " CN; CN="${CN:-Betting Bazaar}"
read -r -p "Two-letter country code [IN]: " COUNTRY; COUNTRY="${COUNTRY:-IN}"

# 32 characters from a CSPRNG. PKCS12 keystores use ONE password for the store
# and the key, so ANDROID_KEY_PASSWORD is the same value.
KS_PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
export KS_PASS
keytool -genkeypair -v \
  -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=${CN}, O=${CN}, C=${COUNTRY}" \
  -storepass:env KS_PASS -keypass:env KS_PASS >/dev/null 2>&1 || die "keytool could not create the key."
chmod 600 "$KEYSTORE"

FINGERPRINT="$(keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:env KS_PASS 2>/dev/null \
  | awk '/SHA256:/ {print $2; exit}')"
[ -n "$FINGERPRINT" ] || die "Could not read the new key's fingerprint."
ok "Signing key created (valid ~27 years)"

# ── 3. The backup — before anything else can go wrong ──────────────────────
umask 077
cat > "$BACKUP" <<EOF
BETTING BAZAAR — ANDROID RELEASE SIGNING KEY — KEEP FOREVER, KEEP PRIVATE
Created: $(date -u +%Y-%m-%dT%H:%MZ)    Repository: $REPO

Losing this means no installed copy of the app can ever be updated again.
Store this whole note in a password manager (as a secure note) AND one more
place you control. Never in the repository, a chat, an email or a screenshot.

Key alias ............ $ALIAS
Keystore password .... $KS_PASS
Key password ......... $KS_PASS   (same — PKCS12 uses one password)
SHA-256 fingerprint .. $FINGERPRINT

To restore the keystore file from this note:
  base64 -d > upload-keystore.jks <<'KEY'
$(b64 "$KEYSTORE")
KEY
EOF
chmod 600 "$BACKUP"

bold ""
bold "STEP 1 OF 2 — SAVE THE BACKUP NOW"
echo "Open it:   code \"$BACKUP\""
echo "Select all, copy it into your password manager as a secure note, and save it"
echo "in one more place you control. (It contains the password and the whole key.)"
while true; do
  read -r -p "Type SAVED once it is stored in your password manager: " saved
  [ "$saved" = "SAVED" ] && break
done

# ── 4. GitHub secrets ───────────────────────────────────────────────────────
b64 "$KEYSTORE" | GH secret set ANDROID_KEYSTORE_BASE64 -R "$REPO"
printf '%s' "$KS_PASS" | GH secret set ANDROID_KEYSTORE_PASSWORD -R "$REPO"
printf '%s' "$ALIAS"   | GH secret set ANDROID_KEY_ALIAS -R "$REPO"
printf '%s' "$KS_PASS" | GH secret set ANDROID_KEY_PASSWORD -R "$REPO"
ok "Secrets set: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD"

# ── 5. GitHub variables (public URLs, not secrets) ──────────────────────────
ask_origin() {  # prompt, variable name
  local v
  while true; do
    read -r -p "$1 " v
    if [[ "$v" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] && [[ "$v" != https://localhost* ]]; then
      printf '%s' "$v"; return
    fi
    echo "  Use https://your-domain only — no path, no trailing slash, not localhost." >&2
  done
}
bold ""
bold "STEP 2 OF 2 — WHERE THE APP CONNECTS"
API_URL="$(ask_origin 'Backend API origin (e.g. https://api.yourdomain.com):')"
APP_ORIGIN="$(ask_origin 'Public site origin = the backend PUBLIC_APP_ORIGIN (e.g. https://yourdomain.com):')"
GH variable set ANDROID_API_URL -R "$REPO" --body "$API_URL"
GH variable set ANDROID_APP_ORIGIN -R "$REPO" --body "$APP_ORIGIN"
ok "Variables set: ANDROID_API_URL=$API_URL, ANDROID_APP_ORIGIN=$APP_ORIGIN"

# ── 6. What the server needs ────────────────────────────────────────────────
bold ""
bold "Put these in the BACKEND's environment (deploy/vps/.env on your server):"
echo "  ANDROID_PACKAGE_ID=com.bettingbazaar.app"
echo "  ANDROID_SHA256_CERT_FINGERPRINTS=$FINGERPRINT"
echo "  ALLOWED_ORIGINS=<your existing origins>,https://localhost"
echo
echo "Then build: GitHub → Actions → \"Android release\" → Run workflow."
echo "Upload the app-release.apk it produces on the admin panel's Android App page."

# ── 7. Clean up this machine ────────────────────────────────────────────────
bold ""
read -r -p "Delete the local key and backup note from this machine now? GitHub and your password manager have them. [y/N] " wipe
if [[ "$wipe" =~ ^[Yy]$ ]]; then
  if command -v shred >/dev/null; then shred -u "$KEYSTORE" "$BACKUP"; else rm -P "$KEYSTORE" "$BACKUP" 2>/dev/null || rm -f "$KEYSTORE" "$BACKUP"; fi
  rmdir "$DIR" 2>/dev/null || true
  ok "Local copies removed. Delete this Codespace too if you created it only for this."
else
  echo "Kept in $DIR. Delete them once you are sure the backup is safe:  shred -u \"$KEYSTORE\" \"$BACKUP\""
fi
unset KS_PASS

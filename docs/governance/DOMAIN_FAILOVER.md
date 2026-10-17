<!-- GOVERNANCE: Read CLAUDE.md before editing this file. -->
# When a domain is blocked

How the player apps keep working when the site's domain is blocked, what to set
up once, and what to do on the day. Rules live in `CLAUDE.md` §2 ("The API host
player apps are sent to", "A Telegram sign-in") and §33.2; this file is
procedure. The signing key itself is `GATEWAY_KEY_ROTATION.md`.

The design in one paragraph: a **pool of standby domains** is registered ahead
of time and kept **private**. The gateway document, which is **signed offline**,
names the live hosts and only the **next** standby (owner, 2026-10-17): it is
published, so anyone blocking the site can read it, and everything in it can
be blocked in advance. That one signed file is **published to several mirrors**
that live off our own domains (GitHub, jsDelivr, Cloudflare, IPFS, every API
server), and the mirror URLs are **baked into every build**. When the live
domain is blocked, you point the next standby's DNS at the server and every
install already trusts it and moves to it on its own; then you sign and publish
a new version naming the standby after it. The **Telegram Mini App link**
(`t.me/...`) is Telegram's address, not ours, so it is the way in that never
dies, for new players and for anyone whose app was cleared.

Nothing here puts the signing key online. A mirror, its upload token, or a
compromised server can withhold the document or serve an older one; it cannot
add a host, because every app verifies the signature against the key it was
built with and refuses a version below the highest it has seen.

## What each client does when its domain is blocked

| Client | Opens? | Talks to the API? | Signs in? |
| --- | --- | --- | --- |
| Android app (APK) | Yes, the app is in the APK | Yes: probes every built-in and signed host at once, takes the first that answers (`originFailover.ts`) | Yes. If the site moved away from the address baked into the APK's App Link, the server answers MATCH instead of HANDOFF, so the two-digit number reaches the app (`deliveryFor`) |
| Android installed web app (PWA) | Yes, from its service worker's cache | Yes, the same failover, with its own address as the primary (`selfOrigin`), once built with the gateway key | Yes, MATCH as above when its address is no longer the site's |
| iPhone Home Screen web app | Yes, from cache | Yes, the same failover | Yes, iPhone always uses MATCH |
| A browser tab on the blocked address | No: the address does not load for someone who never installed it | n/a | They come in through the Telegram link instead |
| Telegram Mini App | Yes: `t.me/<bot>/<app>` is Telegram's, and its page is whatever URL BotFather has | Yes, from the Mini App's own (current) address | Verify signs them in and opens the site at its current address |

Two limits worth knowing:

- An installed web app that has **never** connected since its build learned the
  pool reads it from the mirrors on its first failed launch. If the mirrors are
  blocked too, it has only its build-time hosts. That is why the pool should be
  signed and published **before** anything is blocked: every install that
  connects even once remembers it.
- After a move, existing installs keep their **old** address as their own
  origin. They keep working (CORS admits every host of the signed document,
  and `ALLOWED_ORIGINS` admits anything you keep listed there), but a new
  install must come from the new address or from Telegram. Ship an APK built
  with the new `VITE_APP_ORIGIN` when convenient, so its App Link matches the
  site again and sign-in goes back to the one-tap HANDOFF.

## One-time setup

### 1. Register the standby pool

Register 4 to 10 domains you will never advertise until needed. Use different
TLDs and, ideally, two registrars, so one takedown does not take them all. You
need not point their DNS anywhere yet.

Write them into a hosts file kept with your offline key, never in this
repository: the live hosts, a `[standby]` line, then the pool in the order you
will use it:

```
# live
bettingbazaar.com
[standby]
bb-standby-one.net
bb-standby-two.org
bb-standby-three.in
```

Signing a hosts file names the live hosts and the FIRST standby only
(`--standby-ahead 1`, the default); the rest of the pool is never published.
The tool refuses a file with no `[standby]` line, so an old file that listed
the whole pool cannot be signed whole by mistake. A document may name up to
16 hosts (`GATEWAY_MAX_HOSTS`).

### 2. Sign the document offline

On the offline machine (`GATEWAY_KEY_ROTATION.md` covers the key):

```
npm run gateway-config -- sign --key /secure/gateway-primary.pem --version 1 \
  --hosts-file pool.txt --days 300 --out gateway-v1.json
```

### 3. Set up the mirrors

Do whichever you can; two or more is the point. Keep the tokens in a local file
you `source` before publishing, never in git (each can write only its own mirror):

```
# gateway-mirrors.env  (chmod 600, not in any repository)
export GATEWAY_MIRROR_GITHUB_REPO=yourname/bb-gateway        # a PUBLIC repo holding only this file
export GATEWAY_MIRROR_GITHUB_TOKEN=github_pat_...             # fine-grained: Contents read/write, that repo only
export GATEWAY_MIRROR_CF_ACCOUNT_ID=...
export GATEWAY_MIRROR_CF_NAMESPACE_ID=...
export GATEWAY_MIRROR_CF_TOKEN=...                            # Workers KV Storage: Edit
export GATEWAY_MIRROR_CF_URL=https://bb-gateway.yourname.workers.dev/gateway.json
export GATEWAY_MIRROR_IPFS_API=http://127.0.0.1:5001          # a kubo node you keep running
export GATEWAY_MIRROR_DIRS=./to-servers                       # a local copy to place on each API server
```

- **GitHub + jsDelivr.** Create a public repository with nothing in it but this
  file. One push serves it at `raw.githubusercontent.com` and through jsDelivr
  (`cdn.jsdelivr.net/gh/...`), two mirrors from different networks.
- **Cloudflare Worker.** `deploy/gateway-mirror/`: create a KV namespace
  (`npx wrangler kv namespace create GATEWAY`), put its id in `wrangler.toml`,
  `npx wrangler deploy`. The Worker serves `/gateway.json` from KV to anyone.
- **IPFS.** Run a kubo node (any small always-on machine). The script makes an
  IPNS key on first use and publishes under it, so the URL never changes; the
  node must stay online to keep the name resolvable. It holds the IPNS key,
  never the signing key.
- **Each API server.** Place the file at `deploy/vps/gateway/gateway.json`; the
  app containers mount that folder read-only, serve it at
  `/api/v1/client/gateway-config`, and read its hosts for the standby pool.
  Set `GATEWAY_CONFIG_PUBLIC_KEY` in `.env`.
- **Arweave** is not supported: every upload there gets a new address, so no
  URL could be baked into a build in advance.

Then publish:

```
source gateway-mirrors.env
npm run gateway-publish -- publish --public-key <the build's public key> --document gateway-v1.json
```

It verifies the document, refuses one older than any mirror already serves,
uploads it everywhere, and reads every public URL back. Re-running with the
same file is safe (finishes a partial publish).

### 4. Bake the mirrors into every build

```
npm run gateway-publish -- urls      # prints the comma-separated list
```

- **Web (site and installed web app):** in `deploy/vps/.env` set
  `VITE_GATEWAY_CONFIG_PUBLIC_KEY` and `VITE_GATEWAY_CONFIG_URLS`, then rebuild
  (`docker compose -f docker-compose.prod.yml up -d --build`). Without the key a
  web build is a plain same-origin deploy that cannot move.
- **Android APK:** repository variables `ANDROID_GATEWAY_CONFIG_PUBLIC_KEY` and
  `ANDROID_GATEWAY_CONFIG_URLS` (`ANDROID_RELEASE_SETUP.md`), then a release.

The same two variables drive `.github/workflows/gateway-watch.yml`, which checks
every mirror weekly and fails when one is dead, stale or within 21 days of expiry.
Run the same check yourself any time:

```
npm run gateway-publish -- check --public-key <key> --urls <the list>
```

### 5. Let standby hosts get HTTPS on first use

`deploy/vps/Caddyfile.vps` already does this: any name that is not in
`SITE_ADDRESS` gets a certificate the first time someone reaches it, but only
after Caddy asks the app (`GET /api/v1/client/tls-allowed`) and the app says
the name is in `DOMAINS`, `API_ALLOWED_HOSTS`, `PUBLIC_APP_ORIGIN` or the signed
document. A stranger's name pointed at your server gets nothing.

### 6. Telegram

In BotFather, give the bot a Mini App (`/newapp`) whose URL is
`https://<current site>/mini-app.html`, and save the bot in the admin panel's Telegram settings.
The app then shows the link (`https://t.me/<bot>/<app>`) on the Invite screen
and on its "Can't connect" screen, and remembers it. Announce it to players as
the address that always works.

Then register up to three **standby bots** the same way (each its own bot in
BotFather, each with a Mini App at the same page) and save them in the
Standby slots of the same screen. Every account belongs to the person's
Telegram, so each standby already knows everyone. Every second the
server asks Telegram about the bot in use; when Telegram refuses its token
(banned or revoked), it is suspended, an alert is sent, and every new sign-in
and link names the next standby. The app remembers every working bot's link,
and its "Can't connect" screen offers the standbys as backups. Nothing to do on
the day except, later, replace the banned bot with a fresh one.

### 7. Keep retired addresses allowed

Never remove an address from `ALLOWED_ORIGINS` after it is retired. Installed
apps on that address still call the API from it.

## On the day a domain is blocked

No signing, no build, no app update:

1. Take the next host from the pool. Point its DNS A record at the server (in
   Cloudflare, grey cloud, "DNS only"). Caddy takes its certificate on the first
   visit.
2. In `deploy/vps/.env` set `PUBLIC_APP_ORIGIN` (and `APP_BASE_URL`) to
   `https://<that host>`, add the host to `DOMAINS`, keep the old origin in
   `ALLOWED_ORIGINS`, and restart: `docker compose -f docker-compose.prod.yml up -d`.
3. In BotFather, `/myapps` › your app › Edit Web App URL ›
   `https://<that host>/mini-app.html`, for the bot AND every standby bot.
4. Tell players: open the Telegram link, or just reopen the app.

Installed apps (APK and web) find the new host by themselves on their next
request that fails. Sign-ins from an app on the old address use the number
match until a new APK ships.

The same day, as soon as you can: the standby you just used is now live, and
the public document names no standby any more. Edit the hosts file (the new
host under the live hosts, the blocked one removed, the used standby taken off
the pool), sign a new version and publish it the same way. It names the next
standby, and installs that reach a mirror pick it up. Register a fresh domain
at the end of the pool when the pool runs short.

Because the next standby is public, a blocker may block it in advance. If it
is already blocked on the day, skip it: point the one after it instead, sign
a version naming it as live, and publish. Installs that can reach a mirror
move to it; an install that cannot reach a mirror comes back through the
Telegram link.

## Checklist

- [ ] Pool of standby domains registered (different TLDs)
- [ ] Hosts file (live, `[standby]`, pool) kept offline with the key, never committed
- [ ] Document signed offline: live hosts and the next standby only
- [ ] Published to at least two mirrors, and to every API server
- [ ] `VITE_GATEWAY_CONFIG_PUBLIC_KEY` and `VITE_GATEWAY_CONFIG_URLS` in the web build; web rebuilt
- [ ] `ANDROID_GATEWAY_CONFIG_PUBLIC_KEY` and `ANDROID_GATEWAY_CONFIG_URLS` set; APK released
- [ ] `GATEWAY_CONFIG_PUBLIC_KEY` on the server
- [ ] Gateway watch workflow green
- [ ] Bot and Mini App saved; Telegram link announced
- [ ] Standby bots (each with its Mini App) saved in the Standby slots
- [ ] Retired origins kept in `ALLOWED_ORIGINS`

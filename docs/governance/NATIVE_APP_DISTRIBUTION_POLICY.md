# Native app and desktop distribution policy

> **Read §1 before planning any store listing.** The distribution question for
> this product is not "Play, App Store, or direct APK" — for India it is
> upstream of all three, and the answer changes what is worth building.
>
> Nothing here is legal advice. It is a statement of what the published law and
> the store policies say, so that the engineering plan is not built on an
> assumption nobody checked. Take Indian gaming-law counsel before launch.

---

## 1. The binding constraint: India prohibits this category outright

The **Promotion and Regulation of Online Gaming Act, 2025** received assent on
22 August 2025 and **came into force on 1 May 2026**, together with the
Promotion and Regulation of Online Gaming Rules, 2026.

It is not a licensing regime for real-money gaming. It is a prohibition.

| Section | What it prohibits | Maximum penalty |
|---|---|---|
| **§5** | Offering, aiding, abetting, inducing or otherwise engaging in the offering of an *online money game* or *online money gaming service* | 3 years' imprisonment and/or ₹1 crore |
| **§6** | Any advertisement, in any medium, that directly or indirectly promotes or induces a person to play an online money game | 2 years' imprisonment and/or ₹50 lakh |
| **§7** | Any bank, financial institution **or other person facilitating financial transactions** engaging in, permitting, aiding or facilitating a transaction connected to an online money gaming service | 3 years' imprisonment and/or ₹1 crore |

**The definition reaches this product directly.** An *online money game* is a
game played on payment of a fee or deposit of money or other stakes, in
expectation of winning money or other stakes — **regardless of whether it turns
on skill, chance, or both**. The Act deliberately abolishes the skill/chance
distinction that earlier Indian case law turned on. Framing the product as a
*prediction market* rather than a *bet* does not move it outside the
definition: players stake money on a binary outcome and are paid from a pool.

**Three consequences that the engineering plan has to absorb:**

1. **There is no Indian licence to obtain.** `LAUNCH_READINESS.md` §G lists a
   "gambling/gaming licence for each jurisdiction served" as a hard gate. For
   India that gate cannot be cleared by acquiring anything — the category is
   prohibited, not regulated. Only e-sports recognised under the National
   Sports Governance Act, 2025, and games with no stake, sit outside it.
2. **Direct APK download does not route around it.** §5 covers *offering* the
   service by any means. The distribution channel is not what is prohibited;
   the service is. Sideloading changes who reviews the app, not whether
   operating it is lawful.
3. **§7 severs the P2P settlement rail specifically.** The merchant network in
   this codebase consists of "other persons facilitating financial
   transactions" for the platform. That is the exact language of §7, and it
   attaches to the merchants personally, not only to the operator.

**Litigation status (as of 2026-08-26):** constitutional challenges are before
the Supreme Court, which has referred them to a larger bench. The Court
**declined an interim stay**, so the Act is in force and enforceable while the
challenge is pending. Plan against the law as it stands, not as it might be
decided.

**Enforcement is aimed at the stores too.** MeitY has directed app stores and
OTT platforms to stop enabling money games, so a Play or App Store listing
serving India is being closed from the platform side as well as the statutory
one.

### What this leaves

| Option | Viable? | What it needs |
|---|---|---|
| Serve Indian players (any channel: Play, App Store, sideloaded APK, plain web) | **No** | Nothing makes it lawful while the Act stands |
| Serve a jurisdiction that licenses this category | Possibly | A licence there, geo-restriction to it, and the KYC/AML programme that licence requires. The identity model here is Aadhaar-based and India-specific — it does not transfer |
| Remove the stake (free-to-play, no cash-out) | Yes | Outside the Act's definition, and a different product |
| E-sports under the National Sports Governance Act, 2025 | Yes | A different product again |

**Do not build toward a store listing until the target jurisdiction is
decided.** Store metadata, content ratings, gambling declarations and a
data-safety form are all per-jurisdiction work, and none of it is meaningful
while the answer to "which country is this licensed in" is unresolved.

---

## 2. If a permitted jurisdiction is chosen: what each channel then requires

These are the store rules, which apply *on top of* holding a licence — not
instead of one.

**Google Play.** Real-money gaming apps are allowed only in a specific list of
countries, only for operators who hold a licence in each such country, and only
after Google approves a separate application per country. The app must
geo-restrict itself to the approved countries, carry an age gate, and declare
gambling content in the data-safety and content-rating forms. Google Play does
not take a service fee on the wagers themselves, but it does gate the listing.

**Apple App Store.** Stricter in three ways that matter here.

- **Guideline 5.3.4** — real-money gaming apps must hold the necessary licensing
  and permissions in every location where the app is used, must be geo-restricted
  to those locations, and must be **free** on the App Store.
- **Organisation account required.** Apple does not accept gambling apps —
  real-money *or* gambling-simulating — from individual developer accounts. Only
  a verified incorporated entity may submit one. An individual account gets the
  app rejected or removed.
- **Guideline 5.3.3** — such apps **may not use in-app purchase** to buy credit
  or currency for real-money gaming. This one the codebase already satisfies by
  construction: deposits run through the P2P merchant rail
  (`fundingAuthority.service.js`), never through IAP. Worth knowing it is a rule
  rather than a preference, because "just add IAP top-ups on iOS" is a natural
  suggestion that would get the app rejected.

**Direct APK download.** No review, no per-country approval, and the channel
the `/api/download/android` redirect and `SystemConfig.androidUrl` already
support. It carries its own costs, and they are real: no automatic updates
(so a version floor and an "update required" gate become load-bearing — see
`FULL_STACK_AND_CLIENT_DELIVERY.md` §3.5), users must enable "install unknown
apps", Play Protect warns on install, and there is no store-side integrity
signal. It is the only channel that does not require a store's permission —
but, per §1, that is not the same as requiring nobody's.

---

## 3. Approved client architecture

Unchanged, and independent of the above: whichever clients ship, they talk to
the licensed origin and nothing else.

```text
Desktop browser / Android WebView / installed PWA
        │
        ▼
Official HTTPS origin (PUBLIC_APP_ORIGIN)
        │
        ▼
Caddy edge controls, WAF/header normalization, auth, KYC, geofence checks
        │
        ▼
Backend APIs and financial ledger
```

Native shells call `GET /api/app/bootstrap` during startup and verify that
`officialOrigin` is in `allowedOrigins` before opening the WebView. That
endpoint also returns the compliance block (`geofenceRequired`, `kycRequired`,
`hiddenProxyOrVpn: false`, `networkBypassSupported: false`).

**No bundled VPN or proxy — recorded decision** (`04-GOVERNANCE.md` §20,
2026-07-28). Shipping a circumvention transport inside a real-money client
would place bets from where the platform is not licensed to accept them. Under
§1 that is no longer a store-policy problem; it is an offence.

**Client inventory.** Android: a Capacitor 8 shell at `user-panel/android/`
(user panel only). PWA: user panel only. iOS: **installed PWA, no native shell**
— recorded decision, see `FULL_STACK_AND_CLIENT_DELIVERY.md` §3.6. The
`iosBundleId` field in `/api/app/bootstrap` remains for a future client and is
`null` until one exists.

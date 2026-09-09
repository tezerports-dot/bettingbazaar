# Branding — field to consumer

> **This document holds data and history, never rules.** Every rule lives in
> `CLAUDE.md`, which is the single rules file and outranks this document.
> Extracted from the former `CLAUDE.md` on 2026-09-09.

The branding rules are `CLAUDE.md` §13. This file is the field table only:
every branding field must have a real consumer, and this is the list.

This section is the canonical answer to GAP-1 (the 3-way broken chain). Every panel follows
the same bootstrap sequence:

**Backend (single source of truth):**
1. The `Branding` row (key=`'main'`) holds all branding fields.
2. `sendBranding()` in `socketHandlers.js` reads the `Branding` document and pushes the full
   payload on every client connect. It is the **sole constructor** of the branding socket payload.
   It must **never** emit hardcoded filenames or colors.
3. `PUT /api/admin/branding` saves **all** Branding schema fields via `$set` spread, then
   re-emits `branding_updated` with the full document so all panels update live.

**All three frontends (user, admin, merchant):**
1. On `branding` socket event: store payload in `localStorage.app_branding`.
2. Apply `--brand-primary` (and `--brand-secondary`, `--brand-accent`) as CSS variables on
   `document.documentElement`.
3. Set `document.title` to the appropriate panel name field
   (`userPanelName` / `adminPanelName` / `merchantPanelName`).
4. On `branding_updated` socket event: repeat steps 1–3 with `event.branding`.

**Admin panel additionally:**
- `Layout.tsx` reads `adminPanelName` from `localStorage.app_branding` for the sidebar header.
- `Login.tsx` reads version from `VITE_APP_VERSION` (built from `package.json`), not a literal.

**Logo URL construction:**
```
cdnBase = branding.cdnBaseUrl.replace(/\/+$/, '')
logo    = branding.logo.startsWith('http')
          ? branding.logo
          : cdnBase + '/' + branding.logo.replace(/^\/+/, '')
```
Never concatenate `cdnBase + '/' + logo` without normalising both sides (C-07 fix).

**Branding fields that must have real consumers (GOVERNANCE §2):**

| Field | Consumer |
|---|---|
| `logo` | Header.tsx, ShareModal.tsx, admin Layout.tsx |
| `icon` | `public/manifest.json` (PWA, manual or build step) |
| `favicon` | `<link rel="icon">` in `index.html` (injected at runtime or build) |
| `primaryColor` | `--brand-primary` CSS variable |
| `secondaryColor` | `--brand-secondary` CSS variable |
| `accentColor` | `--brand-accent` CSS variable |
| `userPanelName` | `document.title` in user panel, App.tsx |
| `adminPanelName` | `document.title` in admin panel, admin Login.tsx, Layout.tsx |
| `merchantPanelName` | `document.title` in merchant panel |
| `homePopupImageUrl` | GameContext.tsx or HomePage modal (implement consumer) |
| `homePopupEnabled` | Same — gate display on this boolean |
| `tricksTipsBannerUrl` | PromoPage.tsx banner (C-06 fix) |
| `rulesPageImageUrl` | RulesPage.tsx banner (C-06 fix) |
| `depositPageBannerUrl` | WalletModal.tsx buy-tokens section |
| `withdrawalPageBannerUrl` | WalletModal.tsx sell-tokens section |
| `loginPageBannerUrl` | AuthModal.tsx or Login page background |
| `registerPageBannerUrl` | AuthModal.tsx register tab |
| `betCardDelhiImageUrl` | redesign `GameScreen` DELHI bet-card background (resolved via `getAssetUrl`) |
| `betCardBombayImageUrl` | redesign `GameScreen` BOMBAY bet-card background (resolved via `getAssetUrl`) |

---

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/// <reference types="vite/client" />

// Build-time configuration for the player panel, baked in by Vite.
//
// This interface is the typed mirror of `user-panel/.env.example` — keep the
// two in step. Every entry below has a real consumer in this panel; a declared
// variable nothing reads is a §2 violation (a frontend mirror with zero
// consumers), and it is worse than useless here because it reads as supported
// configuration. `VITE_WS_URL` was exactly that and was removed on 2026-08-31:
// it was declared, documented nowhere, and read by no code — realtime resolves
// its origin through `originFailover` like every other call.
interface ImportMetaEnv {
  /** Absolute API origin. Optional on a same-origin web deploy; MANDATORY for
   *  the native build, which has no same-origin backend to fall back on. */
  readonly VITE_API_URL: string;
  /** ONE explicitly configured backup origin (https hostname), used when the
   *  primary stops answering (`services/originFailover.ts`). */
  readonly VITE_API_BACKUP_URL?: string;
  /** HTTPS URL answering `{"url": "https://…"}` — the endpoint-discovery
   *  service read during the LoadingScreen (`services/originFailover.ts`). */
  readonly VITE_API_DISCOVERY_URL?: string;
  /** Comma-separated EXACT hostnames discovery may name, beyond the primary's
   *  and the backup's. No wildcards, no IP addresses. */
  readonly VITE_API_ALLOWED_HOSTS?: string;
  /** Ed25519 public key (base64url, 32 bytes) a signed gateway document must verify against (`services/gatewayConfig.ts`). */
  readonly VITE_GATEWAY_CONFIG_PUBLIC_KEY?: string;
  /** HTTPS mirrors of the signed gateway document, comma-separated. */
  readonly VITE_GATEWAY_CONFIG_URLS?: string;
  /** The panel's public origin — the backend's `PUBLIC_APP_ORIGIN`. MANDATORY
   *  for the native build: it decides which deep links the shell trusts, and
   *  its host is baked into the APK's App Link filter. */
  readonly VITE_APP_ORIGIN?: string;
  /** Where `/merchant` links point on a split-origin deploy. */
  readonly VITE_MERCHANT_PANEL_URL?: string;
  /** Cloudflare Turnstile site key (public half); the gate is a pass-through
   *  until it and the backend's secret half are both set. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /** Injected at build time from package.json — never typed into a source
   *  file (§2 forbids a version literal in a component). */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Capacitor configuration — the native Android shell around the user panel.
 *
 * The web assets are BUNDLED INTO THE APK (`webDir: 'dist'`), not loaded from a
 * remote URL. That is the difference between a native app and a browser
 * pointed at a website: the UI ships in the package, starts offline-capable and
 * instantly, and only the API is remote. A `server.url` pointing at production
 * would turn this back into a thin web view — and stores treat that as a
 * repackaged website.
 *
 * ── The API base is a BUILD-TIME input, and it is mandatory ─────────────────
 * Inside the shell `window.location` is `https://localhost`, so
 * `services/realBackend.ts` sees `hostname === 'localhost'`, takes its
 * local-development branch and resolves the API to `http://localhost:8080/api`
 * — the phone itself. An APK built without `VITE_API_URL` therefore looks
 * perfectly healthy and reaches nothing.
 *
 * `npm run build:native` refuses to build without it (see scripts/assert-native-env.mjs)
 * rather than leaving that to whoever runs the release next.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bettingbazaar.app',
  appName: 'Betting Bazaar',
  webDir: 'dist',

  android: {
    // Every network call must be TLS. The API is HTTPS; nothing in this app has
    // a reason to speak plaintext, so the platform is told to forbid it (and
    // res/xml/network_security_config.xml enforces the same at the OS layer).
    allowMixedContent: false,
    captureInput: true,
  },

  server: {
    // Serve bundled assets over https://localhost rather than the legacy
    // http://. A secure context is required for crypto.subtle and the storage
    // APIs the auth layer uses, and it keeps mixed-content rules meaningful.
    // (androidScheme belongs here, not under `android` — Capacitor's types
    // reject it there, which is how this was caught.)
    //
    // Bundled assets only: no `url:` key. A future edit adding one turns this
    // back into a thin web view, so its absence is deliberate and load-bearing.
    androidScheme: 'https',
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#0A0E17',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',            // dark content style => light icons on the dark shell
      backgroundColor: '#0A0E17',
      overlaysWebView: false,
    },
  },
};

export default config;

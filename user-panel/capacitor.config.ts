// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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

/**
 * The app's dark ground, behind everything native draws before the bundle
 * paints: the WebView itself, the splash and the status bar. A §5 mirror of
 * `theme_color` in public/manifest.json, and of `BG` in
 * scripts/generate-icons.mjs, which writes it into the Android colour
 * resource. src/services/nativeBrand.test.ts fails if the three disagree —
 * they had already (this said #0A0E17 while the manifest said #0B0E14).
 *
 * A native resource cannot read the admin's Branding at runtime, so this is
 * §11's allowed exception: a build-time value, never used for anything the
 * server decides.
 */
const BRAND_BACKGROUND = '#0B0E14';

const config: CapacitorConfig = {
  appId: 'com.bettingbazaar.app',
  appName: 'Betting Bazaar',
  webDir: 'dist',
  // The WebView's own background. Unset it is white, and it is what shows for
  // the frames between the splash hiding and the first paint.
  backgroundColor: BRAND_BACKGROUND,

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
      backgroundColor: BRAND_BACKGROUND,
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',            // dark content style => light icons on the dark shell
      backgroundColor: BRAND_BACKGROUND,
      overlaysWebView: false,
    },
  },
};

export default config;

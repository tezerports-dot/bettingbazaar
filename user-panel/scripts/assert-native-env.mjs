// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Refuses to build the native Android bundle without the environment the shell
 * cannot work without.
 *
 * Inside Capacitor the page is served from `https://localhost`, so
 * services/realBackend.ts sees `hostname === 'localhost'`, takes its
 * local-development branch, and points the app at `http://localhost:8080/api`
 * — the handset itself. Nothing throws; the APK installs, opens, renders the
 * shell and then fails every request. That failure is invisible until someone
 * installs the build on a real phone, which is far too late in a release.
 *
 * So this runs before `vite build` for native targets and stops it dead.
 */
const errors = [];

const apiUrl = process.env.VITE_API_URL;
if (!apiUrl) {
  errors.push(
    'VITE_API_URL is not set.\n' +
    '      The native shell has no same-origin backend to fall back on — it must be\n' +
    '      told the absolute API origin at build time.\n' +
    '      Example: VITE_API_URL=https://api.example.com (no trailing slash, no /api suffix)',
  );
} else {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    errors.push(`VITE_API_URL is not a valid URL: ${apiUrl}`);
  }

  if (parsed) {
    if (parsed.protocol !== 'https:') {
      errors.push(
        `VITE_API_URL must be https (got "${parsed.protocol}").\n` +
        '      The app ships with cleartext traffic disabled at the OS layer, so a\n' +
        '      plaintext origin is blocked by Android regardless of what is configured here.',
      );
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      errors.push(
        `VITE_API_URL points at ${parsed.hostname}, which on a handset is the handset.\n` +
        '      This is the exact failure the check exists to catch.',
      );
    }
    if (/\/api\/?$/.test(parsed.pathname)) {
      errors.push(
        `VITE_API_URL should not include the /api suffix (got "${parsed.pathname}").\n` +
        '      realBackend.ts appends it; including it here produces /api/api/... paths.',
      );
    }
  }
}

// ── Backup origin and discovery (services/originFailover.ts) ───────────────
// Optional, but when set they are held to the same rules as the primary: an
// https hostname, origin only. The allowlist is exact hostnames — a wildcard,
// a URL or an IP address is refused here rather than silently dropped later.
for (const name of ['VITE_API_BACKUP_URL', 'VITE_API_DISCOVERY_URL']) {
  const value = process.env[name];
  if (!value) continue;
  let u;
  try { u = new URL(value); } catch { errors.push(`${name} is not a valid URL: ${value}`); continue; }
  if (u.protocol !== 'https:') errors.push(`${name} must be https (got "${u.protocol}").`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.startsWith('[')) {
    errors.push(`${name} must be a hostname, not an IP address (got "${u.hostname}").`);
  }
  if (name === 'VITE_API_BACKUP_URL' && u.pathname !== '/') {
    errors.push(`${name} must be an origin only, no path (got "${u.pathname}").`);
  }
}
for (const host of String(process.env.VITE_API_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    errors.push(`VITE_API_ALLOWED_HOSTS entry "${host}" is not an exact hostname (no wildcards, URLs or IP addresses).`);
  }
}

// ── The public app origin — whose links this app opens ──────────────────────
// Its HOST is baked into AndroidManifest.xml as the App Link the app claims,
// and the deep-link handler trusts only links from it. The bot's password-reset
// link points at it (`/#/reset/<token>`): with the right origin the tap opens
// the reset screen in the installed app; with a wrong or missing one the tap
// opens a browser and the App Link filter claims a host that no link uses. That
// is a silent, build-time mistake that only shows on a handset, so it is caught
// here rather than on release day. It costs one variable to set.
const appOrigin = process.env.VITE_APP_ORIGIN;
if (!appOrigin) {
  errors.push(
    'VITE_APP_ORIGIN is not set.\n' +
    '      This is the public origin the bot builds reset links against\n' +
    '      (the backend\'s PUBLIC_APP_ORIGIN). The shell uses it to decide which\n' +
    '      incoming links to trust, and its HOST is what the App Link filter in\n' +
    '      AndroidManifest.xml claims.\n' +
    '      Example: VITE_APP_ORIGIN=https://example.com (origin only, no path)',
  );
} else {
  let parsedApp;
  try {
    parsedApp = new URL(appOrigin);
  } catch {
    errors.push(`VITE_APP_ORIGIN is not a valid URL: ${appOrigin}`);
  }

  if (parsedApp) {
    if (parsedApp.protocol !== 'https:') {
      errors.push(
        `VITE_APP_ORIGIN must be https (got "${parsedApp.protocol}").\n` +
        '      Android only verifies App Links over https, and the app ships with\n' +
        '      cleartext traffic disabled at the OS layer.',
      );
    }
    if (parsedApp.hostname === 'localhost' || parsedApp.hostname === '127.0.0.1') {
      errors.push(
        `VITE_APP_ORIGIN points at ${parsedApp.hostname}, which Android can never verify.\n` +
        '      No bot link points there either, so the App Link would match nothing.',
      );
    }
    if (parsedApp.pathname !== '/' || parsedApp.search || parsedApp.hash) {
      errors.push(
        `VITE_APP_ORIGIN must be an origin, not a URL with a path (got "${appOrigin}").\n` +
        '      An App Link filter matches a host; a path here cannot be honoured\n' +
        '      and would give a false impression that it was.',
      );
    }
  }
}

if (errors.length) {
  console.error('\n✖ Native build refused — the APK would install and reach nothing.\n');
  for (const e of errors) console.error(`  • ${e}\n`);
  process.exit(1);
}

console.log(`✅ Native build environment OK — API origin: ${apiUrl}`);
console.log(`   App Link host: ${new URL(appOrigin).hostname}`);

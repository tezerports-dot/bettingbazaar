// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
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

if (errors.length) {
  console.error('\n✖ Native build refused — the APK would install and reach nothing.\n');
  for (const e of errors) console.error(`  • ${e}\n`);
  process.exit(1);
}

console.log(`✅ Native build environment OK — API origin: ${apiUrl}`);

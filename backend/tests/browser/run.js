// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Open every screen in all three panels in a real browser and report what broke.
 *
 * ── Why this tier exists on top of the E2E one ──────────────────────────────
 * `backend/tests/e2e` drives the real server over real HTTP and proves the
 * BACKEND works end to end. It renders nothing. Every defect in the 2026-09
 * review that a person would actually have HIT — the five dead buttons, the
 * permanently empty dispute queue, an announcement stored where no player could
 * read it — was a defect of the browser, not of the server: the request 404'd,
 * the component caught it, and the screen rendered its empty state, which is
 * indistinguishable from "no data" to everything except a pair of eyes (§28).
 *
 * So this opens each screen in Chromium and watches for the three things a
 * person would notice and no route test can see:
 *
 *   1. an uncaught exception  — the screen is blank or half-drawn
 *   2. a request that failed  — the screen is showing an empty state it invented
 *   3. nothing rendered       — whatever the reason
 *
 * ── What it does NOT cover, stated because §29 requires it ──────────────────
 * It installs the token each panel persists rather than typing credentials into
 * the login form, so **the three login screens are not covered by this pass**.
 * The captcha is not what stops that — `TURNSTILE_SECRET_KEY` is unset here and
 * `middleware/captcha.js` is a pass-through in that case — it is the OTP and
 * password flows behind them. That is a real gap and it is named rather than
 * papered over.
 *
 * It also does not click. Opening a screen finds a screen that is broken on
 * arrival; it cannot find a button that does nothing. `check:ui-coverage` is
 * the gate that answers the second question, from the other side.
 *
 *   npm run test:browser                 every panel
 *   npm run test:browser -- admin-panel  only that one
 *   BB_HEADED=1 npm run test:browser     watch it happen
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { panelScreens } from './routes.js';
import { PAGE_SCRIPT, collect, shell, idOf } from './controls.js';
import { check, note, summary } from '../e2e/harness.js';
// ── The stack, shared with `drive.js` — NOT copied ─────────────────────────
// This file had its own PANELS, navigate, settle, waitFor and startVite, and
// its own actor seeding, because it was written before `stack.js` existed. They
// had drifted, and the drift was invisible because both halves ran green: the
// inventory (this file) is the DENOMINATOR the coverage report divides by, and
// it was being taken under a DIFFERENT platform configuration from the drive
// that divides into it. Four corrections `drive.js` had paid for were missing
// here — the cached merchant profile, the cash denomination, the rate-limit
// budget wait, and the enabled game providers — so this pass under-counted by
// exactly the controls those arrange for, and the drive then pressed controls
// the manifest did not know existed. §5, in the form §5 names: the same thing
// assembled twice.
import {
  ROOT, API, EXECUTABLE, PANELS, stopAll, waitFor, startVite,
  navigate, settle, awaitBudget, boot, seedActors, enableGameProviders,
} from './stack.js';

const SHOTS = join(ROOT, 'backend', 'tests', 'browser', 'screenshots');
const MANIFEST = join(ROOT, 'backend', 'tests', 'browser', 'controls.manifest.json');

/** Noise a browser makes that is not this platform's doing. */
const IGNORE = [
  /favicon\.ico/i,
  /\/@vite\/client/,                      // dev-server plumbing
  /Download the React DevTools/i,
  /\[vite\] connect/i,
  /ERR_CONNECTION_REFUSED.*socket\.io/i,  // realtime is its own tier
];
const ignored = (s) => IGNORE.some((re) => re.test(String(s)));

/**
 * A request that reached nothing, for a reason that is not this platform's.
 *
 * Both entries are narrow on PURPOSE: ignoring `fonts.googleapis.com` outright
 * would hide the day the CSP stops allowing it, and ignoring every abort would
 * hide a stream that dies on its own. So each names the exact error as well as
 * the exact URL.
 *
 *  - The font stylesheet IS allowed by the CSP (`styleSrc` in
 *    `config/security.config.js` lists the host, `fontSrc` lists gstatic), and
 *    it loads in a browser on the open internet. What fails here is TLS, in
 *    this sandbox, because outbound HTTPS goes through an inspecting proxy
 *    whose CA the bundled Chromium does not carry.
 *  - An SSE stream is a request that never ends. Opening the next screen
 *    navigates away and the browser aborts it, which is what closing a page is
 *    SUPPOSED to do. The abort is evidence the stream was open — the merchant
 *    panel holds two, the public one and its own (§12).
 */
const ENVIRONMENT = [
  (e, u) => /ERR_CERT_AUTHORITY_INVALID/.test(e) && /fonts\.(googleapis|gstatic)\.com/.test(u),
  (e, u) => /ERR_ABORTED/.test(e) && /\/api\/sse\//.test(u),
];

/** One screen, opened and watched. */
async function visit(page, panel, screen, cfg, base) {
  const errors = [];   // uncaught exceptions
  const console_ = []; // console.error
  const failed = [];   // 4xx/5xx responses
  const dead = [];     // requests that never got a response at all

  const onPageError = (e) => errors.push(e.message);
  // A console error for the font stylesheet carries no URL, so ENVIRONMENT
  // cannot match on the host the way it does for the failed request. The text
  // is unambiguous on its own here: every outbound HTTPS call in this sandbox
  // goes through the inspecting proxy, so an authority failure is that proxy.
  // It is COUNTED rather than dropped, and reported once per panel.
  const onConsole = (m) => {
    if (m.type() !== 'error' || ignored(m.text())) return;
    if (/ERR_CERT_AUTHORITY_INVALID/.test(m.text())) { visit.tls = (visit.tls ?? 0) + 1; return; }
    console_.push(m.text());
  };
  const onResponse = (r) => {
    if (r.status() >= 400 && !ignored(r.url())) {
      failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(API, '').replace(/^https?:\/\/[^/]+/, '')}`);
    }
  };
  const onRequestFailed = (r) => {
    const why = r.failure()?.errorText ?? 'failed';
    if (ignored(r.url()) || ENVIRONMENT.some((f) => f(why, r.url()))) return;
    dead.push(`${why} ${r.url()}`);
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  let nav = 'ok';
  try {
    await navigate(page, cfg, screen, base);
    await settle(page);
  } catch (e) {
    nav = `NAV FAILED: ${e.message.split('\n')[0]}`;
  }

  // ── Measure the ROUTED region, not the document ──────────────────────────
  // All three panels render a persistent shell — sidebar, header, nav — around
  // a routed `<main>`. Counting the whole body makes every screen look alive:
  // an admin screen whose own content failed still reports ~45 controls and
  // ~900 characters of navigation, which is precisely the "empty state that
  // reads as no data" §28 is about, dressed up as a pass. So the screen's own
  // content is `<main>` where a panel has one, and the body only where it does
  // not (the login screens, which render no shell).
  const seen = await page.evaluate(() => {
    const shell = document.body;
    const main = document.querySelector('main') ?? shell;
    const count = (el, sel) => (el ? el.querySelectorAll(sel).length : 0);
    return {
      text:    (main?.innerText ?? '').trim().length,
      buttons: count(main, 'button, [role="button"], a[href]'),
      inputs:  count(main, 'input, select, textarea'),
      scoped:  !!document.querySelector('main'),
      chrome:  (shell?.innerText ?? '').trim().length,
    };
  }).catch(() => ({ text: 0, buttons: 0, inputs: 0, scoped: false, chrome: 0 }));

  page.off('pageerror', onPageError);
  page.off('console', onConsole);
  page.off('response', onResponse);
  page.off('requestfailed', onRequestFailed);

  // Every control a person can touch on this screen, by the name they would
  // use to find it. This is the denominator: "every button tested" is a claim
  // about a number, and the number has to come from the screen itself (§29).
  const controls = await collect(page).catch(() => []);

  const label = `${screen}`;
  const where = seen.scoped ? 'in <main>' : 'on the page';
  const shape = `${seen.text} chars ${where}, ${seen.buttons} controls, ${seen.inputs} inputs`;

  if (nav !== 'ok') {
    check('BROWSER', panel, label, 'the screen opens', nav, false);
    return controls;
  }
  if (errors.length) {
    check('BROWSER', panel, label, 'no uncaught exception', `THREW: ${errors[0]}`, false,
      'an uncaught render error is a blank or half-drawn screen — the thing no route test can see');
    return controls;
  }
  // ── A failed request is only a DEFECT when the screen hides it ───────────
  // §28's defect is the empty state that reads as "no data", not the failed
  // request itself. An unconfigured environment answers 503 by design — the
  // Telegram sign-in details on an install with no bot yet, the passage store
  // on a PostgreSQL without pgvector — and the screen is CORRECT if it renders
  // and says so ("Your link will appear here once sign-in is configured").
  //
  // A 5xx of 500 or worse is different and always fails: the server broke, and
  // `serverError` answers with nothing by design (§2), so whatever the screen
  // draws over it cannot be telling the truth.
  const broke = failed.filter((f) => Number(f.slice(0, 3)) >= 500 && Number(f.slice(0, 3)) !== 503);
  if (broke.length) {
    check('BROWSER', panel, label, 'no 5xx', `${broke.length}: ${broke.slice(0, 3).join(' | ')}`, false,
      'a 500 is answered with no message at all — the screen cannot be showing the reason');
    return controls;
  }
  if (failed.length && seen.text < 40) {
    check('BROWSER', panel, label, 'a refusal the screen explains', `${failed.length} failed and nothing rendered: ${failed.slice(0, 3).join(' | ')}`, false,
      '§28: the component catches it and renders an empty state, which reads as "no data"');
    return controls;
  }
  if (seen.text < 40) {
    check('BROWSER', panel, label, 'the routed region renders something', `only ${shape}`
      + (seen.scoped ? ` (the shell around it drew ${seen.chrome} chars)` : ''), false,
      'a screen with nothing in it is the exact symptom the five dead buttons produced — '
      + 'and the shell drawing normally around it is why nobody saw them');
    return controls;
  }
  if (failed.length) {
    note('BROWSER', panel, label, 'every request answered', `${shape}; ${failed.length} refused: ${failed.slice(0, 2).join(' | ')}`,
      'the screen still rendered, so read it: a refusal a screen EXPLAINS is correct behaviour, '
      + 'and one it hides behind an empty state is the defect');
    return controls;
  }
  if (dead.length) {
    note('BROWSER', panel, label, 'every request reaches something', `${shape}; ${dead.length} unreachable`,
      dead[0].slice(0, 200));
    return controls;
  }
  if (console_.length) {
    note('BROWSER', panel, label, 'a clean console', `${shape}; console.error x${console_.length}`,
      console_[0].slice(0, 160));
    return controls;
  }
  check('BROWSER', panel, label, 'opens, renders, no failed request', shape, true);
  return controls;
}

// ── Run ─────────────────────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = panelScreens().filter((p) => !only.length || only.includes(p.panel));

// `/health/live`, not `/api/v1/system/config`. The config route is rate
// limited — correctly — and a 500ms poll plus a pass that drives 1,700 controls
// through it looks exactly like abuse, so the probe was answered 429 and the
// harness concluded the server was down. The liveness endpoint exists for this.
if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);

// One actor per panel, seeded fresh, so a screen that shows "no data" is showing
// this run's data and not a leftover (trap 10) — and seeded by the SAME
// function the drive uses, so the two halves describe one platform. Seeding it
// here independently is what left the merchant a non-cash merchant, so
// `/cash-links` was inventoried as its "not approved for the ATM cash rail"
// empty state while the drive opened the working screen.
const { actors, cached, restore: restoreTelegram } = await seedActors();

mkdirSync(SHOTS, { recursive: true });

/**
 * The denominator.
 *
 * "Every button tested" is a claim about a NUMBER, and §29 says the number has
 * to be one something printed rather than an impression. This manifest is that
 * number, read off the running screens rather than off the source, so a control
 * that only appears once data is loaded is counted and one that was deleted is
 * not.
 */
const manifest = { takenAt: new Date().toISOString(), shell: {}, screens: [] };

// `/crash` and `/sports` redirect away when their category has no enabled
// provider, and the player panel hides a category button for each. The drive
// enables them; this pass did not, so the denominator was short by exactly
// those controls on every user-panel screen — three per screen, uniformly —
// and a reader comparing two manifests would have read that as deletion.
// Restored in the `finally`, outside any assertion (trap 10).
const restoreProviders = await enableGameProviders();

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'], headless: !process.env.BB_HEADED });

try {
  for (const { panel, screens, skipped, source } of wanted) {
    const cfg = PANELS[panel];
    const base = `http://127.0.0.1:${cfg.port}`;
    const { log } = startVite(panel, cfg.port);
    if (!await waitFor(`${base}${panel === 'user-panel' ? '/' : `/${panel.split('-')[0]}/`}`, `${panel}'s dev server`)) {
      check('BROWSER', panel, 'the dev server starts', 'listening', log.join('').slice(-400), false);
      continue;
    }
    note('BROWSER', panel, `${screens.length} screens from ${source}`, 'all opened',
      `${skipped.length} wildcard route(s) skipped: ${skipped.join(' ') || 'none'}`,
      'derived from the panel router, so a new screen joins this pass without anybody remembering to add it');

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(([k, v, extraKey, extraVal]) => {
      try {
        localStorage.setItem(k, v);
        // A returning operator has more than a token: the panel cached their
        // profile last visit. With only the token, the first refused profile
        // call leaves the panel nothing to fall back on and it renders its
        // sign-in screen — which this pass would inventory as a real screen.
        if (extraKey) localStorage.setItem(extraKey, extraVal);
      } catch { /* blocked storage */ }
    }, [cfg.key, cfg.wrap(actors[panel], cached[panel]), cfg.cacheKey ?? '', cfg.cacheKey ? JSON.stringify(cached[panel]) : '']);
    // The control bridge, installed before any page script runs so it survives
    // every navigation the pass makes.
    await ctx.addInitScript(PAGE_SCRIPT);

    const page = await ctx.newPage();
    // Boot once and let the session verify before anything is measured — and
    // refuse a panel that booted logged out, because the inventory it would
    // produce is of a sign-in screen (see `boot` in stack.js).
    const { signedOut, seen } = await boot(page, cfg, base, panel);
    if (signedOut) {
      check('BROWSER', panel, 'boots with its session', 'the panel, signed in',
        `a SIGN-IN screen — a password field is in the routed region. Heading: "${seen.heading}". `
        + `First words: "${seen.text.replace(/\s+/g, ' ').slice(0, 120)}". Nothing below `
        + 'describes this panel. Re-run it once the rate-limit window has rolled over.', false);
      await ctx.close();
      continue;
    }

    // The shell is the same links on every screen of a panel, so it is
    // inventoried once here rather than 44 times.
    manifest.shell[panel] = await shell(page).catch(() => []);

    for (const screen of screens) {
      // The global limiter is 1,000 requests / 15 min per IP and this pass
      // opens 67 screens. Past the window a screen still RENDERS, just empty —
      // and an empty screen inventoried as the denominator is the coverage
      // report dividing by a number the platform was refusing to produce.
      await awaitBudget(`${panel}${screen}`);
      const controls = await visit(page, panel, screen, cfg, base);
      manifest.screens.push({ panel, screen, controls: controls ?? [] });
      await page.screenshot({ path: join(SHOTS, `${panel}${screen.replace(/\//g, '_') || '_root'}.png`) }).catch(() => {});
    }
    await ctx.close();
    if (visit.tls) {
      note('BROWSER', panel, 'outbound TLS in this sandbox', 'not a platform fault',
        `${visit.tls} console error(s), all ERR_CERT_AUTHORITY_INVALID`,
        'the Google Fonts stylesheet — allowed by the CSP (styleSrc/fontSrc in config/security.config.js) '
        + 'and served fine on the open internet; the bundled Chromium does not carry this proxy\'s CA');
      visit.tls = 0;
    }
  }
} finally {
  await browser.close();
  await restoreProviders().catch(() => {});
  await restoreTelegram().catch(() => {});
  stopAll();
}

writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

// ── The inventory, per panel ───────────────────────────────────────────────
console.log(`\n${'─'.repeat(78)}\nCONTROLS a person can touch\n`);
let grand = 0, unnamed = 0, disabled = 0;
for (const [panel, list] of Object.entries(manifest.shell)) {
  const own = manifest.screens.filter((s) => s.panel === panel);
  const n = own.reduce((t, s) => t + s.controls.length, 0);
  const u = own.reduce((t, s) => t + s.controls.filter((c) => c.unnamed).length, 0);
  const d = own.reduce((t, s) => t + s.controls.filter((c) => c.disabled).length, 0);
  grand += n; unnamed += u; disabled += d;
  console.log(`${panel.padEnd(16)} ${String(n).padStart(4)} in ${String(own.length).padStart(2)} screens`
    + `   + ${String(list.length).padStart(3)} in the shell`
    + `   (${u} unnamed, ${d} disabled on arrival)`);
}
const shellTotal = Object.values(manifest.shell).reduce((t, l) => t + l.length, 0);
console.log(`\n${grand} screen controls + ${shellTotal} shell controls = ${grand + shellTotal} to exercise.`);
console.log(`${unnamed} have NO accessible name — a screen reader announces "button" and nobody can address them.`);
console.log(`Manifest: ${MANIFEST}`);

const { failed } = summary();
console.log(`\nScreenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);

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
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { panelScreens } from './routes.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../e2e/seed.js';
import { playerToken, merchantToken, adminToken, check, note, summary } from '../e2e/harness.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHOTS = join(ROOT, 'backend', 'tests', 'browser', 'screenshots');
const API = process.env.BB_BASE ?? 'http://127.0.0.1:8099';

// The browser is pre-installed in this environment and must not be re-fetched.
const EXECUTABLE = process.env.BB_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Each panel's dev server, its URL shape, and how it persists its token.
 *
 * The auth key is §2's ("one storage key per app") and the SHAPE is each
 * panel's own: the admin panel persists a Zustand envelope, the other two a
 * bare string. Getting that wrong does not error — the panel simply behaves as
 * logged out, and every screen renders its login redirect, which would read as
 * 44 clean screens.
 */
const PANELS = {
  'user-panel':     { port: 5301, entry: (b) => `${b}/#/`,          router: 'hash',    key: 'auth_token',    wrap: (t) => t },
  'admin-panel':    { port: 5302, entry: (b) => `${b}/admin/#/`,    router: 'hash',    key: 'admin-auth',
    wrap: (t) => JSON.stringify({ state: { token: t, admin: null, isAuthenticated: true, mustEnroll2FA: false }, version: 0 }) },
  'merchant-panel': { port: 5303, entry: (b) => `${b}/merchant/`,   router: 'history', base: '/merchant', key: 'merchantToken', wrap: (t) => t },
};

/**
 * ── Drive the panel the way a person does: load it ONCE ─────────────────────
 * The first draft called `page.goto()` per screen, which boots the whole SPA
 * again every time. It reported SIXTEEN admin screens as empty, and every one
 * of them was a lie: the panel verifies its session on boot, and a cold load
 * renders the login screen (or the shell with a spinner) until that resolves —
 * so the measurement was racing the boot, not reading the screen. Warmed up and
 * navigated through its own router, `/settings` draws 11,125 characters.
 *
 * That is worth stating plainly because it is the failure mode this whole tier
 * exists to catch, pointed the other way: a check that measures the wrong
 * moment produces confident, specific, completely false findings, and sixteen
 * of them are more damaging than none. §29 — a claim is about evidence.
 */
async function navigate(page, cfg, screen) {
  if (cfg.router === 'hash') {
    await page.evaluate((s) => { window.location.hash = s; }, screen);
  } else {
    await page.evaluate(([b, s]) => {
      window.history.pushState({}, '', `${b}${s}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, [cfg.base ?? '', screen]);
  }
}

/**
 * Wait for the routed region to stop changing, not for the network to go quiet.
 *
 * `networkidle` is the wrong signal for a panel that holds two open SSE streams
 * and polls — it either never fires or fires before React has rendered the
 * response. This reads what a person would read: the text in `<main>`, until it
 * is non-empty and the same twice running.
 */
async function settle(page, ms = 12000) {
  const read = () => page.evaluate(() => {
    const main = document.querySelector('main');
    return (main ?? document.body)?.innerText?.trim().length ?? 0;
  }).catch(() => 0);
  let last = -1;
  for (let waited = 0; waited < ms; waited += 400) {
    await sleep(400);
    const now = await read();
    if (now > 40 && now === last) return;
    last = now;
  }
}

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

const children = [];
const stopAll = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await sleep(500);
  }
  console.error(`${label} never answered at ${url}`);
  return false;
}

function startVite(panel, port) {
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: join(ROOT, panel),
    env: { ...process.env, VITE_API_URL: API },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  children.push(child);
  return { child, log };
}

/** One screen, opened and watched. */
async function visit(page, panel, screen, cfg) {
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
    await navigate(page, cfg, screen);
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

  const label = `${screen}`;
  const where = seen.scoped ? 'in <main>' : 'on the page';
  const shape = `${seen.text} chars ${where}, ${seen.buttons} controls, ${seen.inputs} inputs`;

  if (nav !== 'ok') {
    check('BROWSER', panel, label, 'the screen opens', nav, false);
    return;
  }
  if (errors.length) {
    check('BROWSER', panel, label, 'no uncaught exception', `THREW: ${errors[0]}`, false,
      'an uncaught render error is a blank or half-drawn screen — the thing no route test can see');
    return;
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
    return;
  }
  if (failed.length && seen.text < 40) {
    check('BROWSER', panel, label, 'a refusal the screen explains', `${failed.length} failed and nothing rendered: ${failed.slice(0, 3).join(' | ')}`, false,
      '§28: the component catches it and renders an empty state, which reads as "no data"');
    return;
  }
  if (seen.text < 40) {
    check('BROWSER', panel, label, 'the routed region renders something', `only ${shape}`
      + (seen.scoped ? ` (the shell around it drew ${seen.chrome} chars)` : ''), false,
      'a screen with nothing in it is the exact symptom the five dead buttons produced — '
      + 'and the shell drawing normally around it is why nobody saw them');
    return;
  }
  if (failed.length) {
    note('BROWSER', panel, label, 'every request answered', `${shape}; ${failed.length} refused: ${failed.slice(0, 2).join(' | ')}`,
      'the screen still rendered, so read it: a refusal a screen EXPLAINS is correct behaviour, '
      + 'and one it hides behind an empty state is the defect');
    return;
  }
  if (dead.length) {
    note('BROWSER', panel, label, 'every request reaches something', `${shape}; ${dead.length} unreachable`,
      dead[0].slice(0, 200));
    return;
  }
  if (console_.length) {
    note('BROWSER', panel, label, 'a clean console', `${shape}; console.error x${console_.length}`,
      console_[0].slice(0, 160));
    return;
  }
  check('BROWSER', panel, label, 'opens, renders, no failed request', shape, true);
}

// ── Run ─────────────────────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = panelScreens().filter((p) => !only.length || only.includes(p.panel));

if (!await waitFor(`${API}/api/v1/system/config`, 'the backend')) process.exit(1);

// One actor per panel, seeded fresh, so a screen that shows "no data" is showing
// this run's data and not a leftover (trap 10).
const actors = {
  'user-panel':     playerToken(await seedPlayer({ balancePaise: 150000 })),
  'admin-panel':    adminToken(await seedAdmin()),
  'merchant-panel': merchantToken(await seedMerchant({ currency: 'INR', tokensPaise: 500000000 })),
};

mkdirSync(SHOTS, { recursive: true });
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
    const token = cfg.wrap(actors[panel]);
    await ctx.addInitScript(([k, v]) => {
      try { localStorage.setItem(k, v); } catch { /* blocked storage */ }
    }, [cfg.key, token]);

    const page = await ctx.newPage();
    // Boot once and let the session verify before anything is measured.
    await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, 30000);

    for (const screen of screens) {
      await visit(page, panel, screen, cfg);
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
  stopAll();
}

const { failed } = summary();
console.log(`\nScreenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);

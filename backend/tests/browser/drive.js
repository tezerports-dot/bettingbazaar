// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Press every control on every screen, and watch what happens.
 *
 * ── What opening a screen could never find ─────────────────────────────────
 * `run.js` opens all 68 screens and catches a screen broken ON ARRIVAL. It
 * cannot find a button that does nothing, a tab that renders the wrong panel,
 * a filter that 500s, or a form that throws away four of your five keystrokes.
 * Those need a finger on the control, which is what this is.
 *
 * ── What counts as "it worked" ─────────────────────────────────────────────
 * Not a toast — a toast is what the screen SAYS happened. Three things are
 * watched instead, in this order:
 *
 *   1. It did not throw. An uncaught error after a click is a half-dead screen.
 *   2. It did not 5xx. A 500 is answered with nothing (§2), so whatever the
 *      screen draws over it cannot be the truth.
 *   3. SOMETHING CHANGED. A control that leaves the screen byte-identical —
 *      same text, same control count, same dialogs, same route — did nothing
 *      that a person could see. That is the dead-button shape (§28), and it is
 *      reported as INERT rather than passed.
 *
 * Inert is a NOTE, not a failure, and that distinction is the honest part: a
 * "Refresh" that re-fetches identical data legitimately changes nothing on
 * screen. The list is triage — every entry gets read, the way `--unused` does.
 *
 * ── What it will not press ─────────────────────────────────────────────────
 * Anything that leaves the app or destroys somebody else's row. Logging out
 * ends the session for every screen after it; deleting the eleventh player in
 * a live queue is not a test, it is an incident. Those are listed as DEFERRED
 * with the reason, and driven deliberately in the mutating pass against rows
 * this run created — never against whatever happened to be in the database
 * (trap 10).
 *
 *   npm run test:drive                      every panel
 *   npm run test:drive -- admin-panel       one panel
 *   npm run test:drive -- admin-panel /kyc  one screen
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { panelScreens } from './routes.js';
import { PAGE_SCRIPT, collect, fingerprint, find, idOf } from './controls.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../e2e/seed.js';
import { playerToken, merchantToken, adminToken, check, note, summary } from '../e2e/harness.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHOTS = join(ROOT, 'backend', 'tests', 'browser', 'screenshots', 'drive');
const REPORT = join(ROOT, 'backend', 'tests', 'browser', 'drive.report.json');
const API = process.env.BB_BASE ?? 'http://127.0.0.1:8099';
const EXECUTABLE = process.env.BB_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const PANELS = {
  'user-panel':     { port: 5301, entry: (b) => `${b}/#/`,        router: 'hash',    key: 'auth_token',    wrap: (t) => t },
  'admin-panel':    { port: 5302, entry: (b) => `${b}/admin/#/`,  router: 'hash',    key: 'admin-auth',
    wrap: (t) => JSON.stringify({ state: { token: t, admin: null, isAuthenticated: true, mustEnroll2FA: false }, version: 0 }) },
  'merchant-panel': { port: 5303, entry: (b) => `${b}/merchant/`, router: 'history', base: '/merchant', key: 'merchantToken', wrap: (t) => t, cacheKey: 'merchantData' },
};

/**
 * Controls this pass will not press, and why.
 *
 * Each is a rule about CONSEQUENCE, not a list of names to keep in step with
 * the UI — §28's "a gate whose failure mode is the author forgot to update me".
 */
/**
 * Names are matched with their decoration STRIPPED.
 *
 * The rules below anchor on the first word — `^release`, `^delete` — and the
 * admin dispute buttons are labelled "✅ Release to User" and "↩️ Refund to
 * Merchant". The emoji is the first character, so every one of those anchors
 * missed, and the pass pressed both of them against 36 live disputed deposits.
 *
 * Nothing moved, and only by luck: the handler opens `window.prompt` for a
 * resolution reason, this pass dismisses dialogs, and `if (!reason?.trim())
 * return;` sent it home. Had that prompt not been there, a test run would have
 * released thirty-six disputed deposits — real money, on someone's database.
 *
 * So the guard is not allowed to depend on how a label is decorated.
 */
const bare = (name) => String(name ?? '')
  .replace(/^[^\p{L}\p{N}]+/u, '')   // leading emoji, arrows, bullets
  .trim();

const DEFER = [
  { why: 'ends the session for every screen after it', test: (c) => /^(log ?out|sign ?out)$/i.test(bare(c.name)) },
  { why: 'leaves the panel', test: (c) => c.kind === 'link' && /^https?:/i.test(c.href) },
  { why: 'downloads a file the browser cannot hand back', test: (c) => /^(export|download|csv|pdf|choose)\b/i.test(bare(c.name)) },
  { why: 'destroys a row this run did not create — driven in the mutating pass, against its own rows (trap 10)',
    test: (c) => /^(delete|remove|reject|suspend|block|deduct|terminate|revoke|purge|reset|wipe|end)\b/i.test(bare(c.name)) },
  { why: 'approves or pays out against a row this run did not create',
    test: (c) => /^(approve|confirm|release|refund|pay|payout|issue|fund|disburse|settle|mint|credit|resolve|escalate)\b/i.test(bare(c.name)) },
  { why: 'publishes a platform-wide change from whatever the form happens to hold',
    test: (c) => /^(save|publish|apply|update|submit|activate|deactivate|switch)\b/i.test(bare(c.name)) },
  { why: 'a file picker cannot be driven from here', test: (c) => c.kind === 'input:file' },
];
const deferred = (c) => DEFER.find((d) => d.test(c));

/** A control that only READS is safe to press anywhere. */
const FIELDS = ['text', 'controls', 'dialogs', 'hash', 'path', 'toast',
                'values', 'checked', 'pressed', 'markup'];
const changed = (a, b) => FIELDS.some((k) => a[k] !== b[k]);
/** Which of them moved — so an INERT note can say what was compared. */
const moved = (a, b) => FIELDS.filter((k) => a[k] !== b[k]);

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

/**
 * Navigate inside the SPA, surviving a press that navigated the whole page.
 *
 * A control CAN be an `<a href>` or a submit button, and those do a real
 * navigation. `page.evaluate` run while one is in flight throws "Execution
 * context was destroyed" and took the whole pass down with it — which is the
 * pass reporting its own fragility as the application's fault. So: wait for the
 * document to settle, try, and on that one specific failure do a hard `goto`.
 */
async function navigate(page, cfg, screen, base) {
  const inSpa = async () => {
    if (cfg.router === 'hash') await page.evaluate((s) => { window.location.hash = s; }, screen);
    else {
      await page.evaluate(([b, s]) => {
        window.history.pushState({}, '', `${b}${s}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, [cfg.base ?? '', screen]);
    }
  };
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  try {
    await inSpa();
  } catch (e) {
    if (!/Execution context was destroyed|Target closed|Navigation/i.test(e.message)) throw e;
    // The press took the browser somewhere. Come back the long way.
    if (base) {
      await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(400);
      await inSpa().catch(() => {});
    }
  }
}

/**
 * Wait for the routed region to stop changing — text AND control count.
 *
 * ── Why both, and why three samples ──────────────────────────────────────
 * The first version compared only the text length, over two consecutive 350ms
 * samples. The shell and the page heading are on screen immediately, so the
 * text is already past the threshold and can sit unchanged for two samples
 * while a fetch is still in flight. On `/users` that made the driver collect
 * ONE control and press it — out of the 353 the screen actually has once its
 * fifty rows arrive. A pass that reports 280 of 1,422 controls pressed while
 * believing it pressed them all is worse than no pass.
 *
 * So: the CONTROL COUNT is watched as well (it is what the pass is about, and
 * it is what grows when rows land), three consecutive identical readings are
 * required rather than two, and there is a floor below which it will not
 * return at all.
 */
async function settle(page, ms = 15000) {
  const read = () => page.evaluate(() => {
    const m = document.querySelector('main') ?? document.body;
    return {
      text: m?.innerText?.trim().length ?? 0,
      controls: m ? m.querySelectorAll('button, a[href], select, textarea, input, [role="button"]').length : 0,
    };
  }).catch(() => ({ text: 0, controls: 0 }));

  const FLOOR = 1600;          // never return before the first fetch could land
  let same = 0, last = null, waited = 0;
  while (waited < ms) {
    await sleep(400);
    waited += 400;
    const now = await read();
    same = (last && now.text === last.text && now.controls === last.controls) ? same + 1 : 0;
    last = now;
    if (waited >= FLOOR && now.text > 40 && same >= 2) return;
  }
}

const IGNORE = [/favicon\.ico/i, /\/@vite\/client/, /\[vite\]/, /Download the React DevTools/i];
const ignored = (s) => IGNORE.some((re) => re.test(String(s)));

/**
 * Press one control and report what it did.
 *
 * The screen is re-read BEFORE and AFTER, and the control is re-found by its
 * triple immediately before the press — the previous press may have re-rendered
 * everything, and a handle captured earlier would be pointing at a node that is
 * no longer in the document.
 */
/**
 * How many instances of ONE control to press per screen.
 *
 * `/users` renders seven row actions across fifty rows: 353 controls, of which
 * 346 are the same seven handlers again with a different id. Pressing the
 * fiftieth Delete proves nothing the first did not, and it costs the run twenty
 * minutes. Three is enough to catch a handler that only works on the row it was
 * written against, and the rest are reported as REPRESENTED rather than quietly
 * dropped — "every button pressed" is a claim about a number (§29), so the
 * number it is NOT is stated too.
 */
const PER_NAME = 3;
/**
 * A screen with no controls is judged by what `<main>` SAYS. Below this it is
 * a shell that failed to render; above it, an empty state explaining itself.
 * Deliberately generous — the shortest real empty state measured here is the
 * merchant cash-links one at 205 characters, and a shell renders 0.
 */
const EMPTY_STATE_MIN_CHARS = 40;

/** How long to stand back when the platform says we are asking too fast. */
const THROTTLE_PAUSE_MS = Number(process.env.BB_THROTTLE_PAUSE_MS ?? 20000);

/**
 * Click a control, re-resolving it if the page re-rendered underneath.
 *
 * ── Why this is not just `el.click()` ──────────────────────────────────────
 * `find()` hands back a handle to a LIVE DOM node, and React replaces nodes on
 * every render. The player panel re-renders on each cycle tick — once a second
 * — so between collecting a control and clicking it, the node it points at can
 * be detached. Playwright then waits for a node that will never again be
 * visible and times out after 4s, and the pass reports UNREACHABLE for a
 * control a person can click without trouble.
 *
 * Measured: the same five player controls — the four game cards and Dismiss
 * announcement — came back UNREACHABLE on all 17 user screens, 172 verdicts in
 * one run against 8 in the run before, with nothing between the two runs that
 * touched the panel. Checked in a browser: not moving, not covered, every one
 * clicks first time. The pass was wrong, and it was wrong by a different
 * amount each run, which is the worst kind of number to put in a table.
 *
 * So the handle is re-resolved on each attempt, and the two reasons a click
 * can fail are kept apart. A node that vanished from under us is OURS. A node
 * that something is covering is the SCREEN'S, and still reported.
 */
async function clickLive(page, c, first, opts = {}) {
  let el = first, last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!el) return { ok: false, why: 'the control is no longer on the screen' };
    try {
      await el.click({ timeout: 4000, ...opts });
      return { ok: true };
    } catch (e) {
      last = e;
      // Something is genuinely on top of it. That is the screen's business,
      // not a re-render race, so stop and report it.
      if (/intercepts pointer events/i.test(e.message)) break;
      const connected = await el.evaluate((n) => n.isConnected).catch(() => false);
      if (connected) break;          // still in the document — a real failure
      await sleep(200);
      el = await find(page, c);      // it was replaced; take the new one
    }
  }
  return { ok: false, why: last ? last.message.split('\n')[0].slice(0, 160) : 'unknown' };
}

async function press(page, panel, screen, c, seen, byName) {
  const id = idOf(panel, screen, c);
  if (seen.has(id)) return { verdict: 'DUPLICATE' };
  seen.add(id);

  const nameKey = `${c.kind}\u0000${c.name}`;
  const nth = (byName.get(nameKey) ?? 0);
  byName.set(nameKey, nth + 1);
  if (nth >= PER_NAME) return { verdict: 'REPRESENTED', why: `instance ${nth + 1} of the same control` };

  const skip = deferred(c);
  if (skip) return { verdict: 'DEFERRED', why: skip.why };
  if (c.disabled) return { verdict: 'DISABLED' };

  const el = await find(page, c);
  if (!el) return { verdict: 'GONE', why: 'the control is no longer on the screen — an earlier press removed it' };

  const before = await fingerprint(page);
  const asked = page.__bbAsked ?? 0;
  const errors = [], failed = [], throttled = [], calls = [];
  const onErr = (e) => errors.push(e.message);
  const onReq = (r) => {
    // What the control ASKED THE SERVER. See the INERT/REFETCHED split below.
    const u = r.url();
    if (/\/api\//.test(u) && !/\/api\/sse\//.test(u)) {
      calls.push(`${r.method()} ${u.replace(/^https?:\/\/[^/]+/, '').slice(0, 80)}`);
    }
  };
  const onRes = (r) => {
    if (r.status() === 429) { throttled.push(r.url()); return; }
    if (r.status() >= 500 && !ignored(r.url())) {
      failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    }
  };
  page.on('pageerror', onErr);
  page.on('response', onRes);
  page.on('request', onReq);

  let acted = 'clicked';
  try {
    if (c.kind.startsWith('input:') && !/checkbox|radio|file|submit|button|range|color/.test(c.kind)) {
      // ── Type what the field is FOR ────────────────────────────────────
      // A text or number field is exercised by TYPING into it, and by more
      // than one character — one keystroke passes on a form that throws the
      // rest away, which is how the winners form stayed broken.
      //
      // WHICH characters matters. The wallet's amount box is `type=text` and
      // filters non-digits, so typing "bb" left it empty and the pass called
      // the money field INERT — accusing correct behaviour. Verified in a
      // browser: "bb" leaves it blank with Continue disabled, "500" fills it
      // and enables Continue. So letters are tried first and, if the field
      // took nothing, digits are tried too; the verdict is about the field,
      // not about the harness's choice of alphabet.
      const digitsFirst = c.kind !== 'input:text'
        || /amount|qty|quantity|number|mobile|phone|pin|otp|tokens|price|rate|limit|min|max|₹|e\.g\. \d/i.test(c.name);
      const r0 = await clickLive(page, c, el);
      if (!r0.ok) throw new Error(r0.why);
      await el.fill('');
      await page.keyboard.type(digitsFirst ? '500' : 'bb', { delay: 40 });
      let held = await el.inputValue().catch(() => '');
      if (!held) {
        // It refused that alphabet. Try the other one before judging it.
        await page.keyboard.type(digitsFirst ? 'bb' : '500', { delay: 40 });
        held = await el.inputValue().catch(() => '');
      }
      acted = held ? `typed ${JSON.stringify(held)} into` : 'typed into (it accepted nothing)';
    } else if (c.kind === 'select') {
      const opts = (c.options ?? []).filter(Boolean);
      if (!opts.length) { acted = 'no options to choose'; }
      else { await el.selectOption(opts[opts.length - 1], { timeout: 4000 }); acted = 'chose an option in'; }
    } else if (c.kind === 'textarea') {
      const r1 = await clickLive(page, c, el);
      if (!r1.ok) throw new Error(r1.why);
      await page.keyboard.type('bb', { delay: 40 });
      acted = 'typed into';
    } else {
      const r2 = await clickLive(page, c, el);
      if (!r2.ok) throw new Error(r2.why);
    }
  } catch (e) {
    // Almost always an overlay left open by an earlier press. Close it and try
    // once more before accusing the control of being unreachable — 23 of these
    // in one run were the harness's own leftovers, not the screen's fault.
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
    try {
      const again = await find(page, c);
      if (!again) throw e;
      const r3 = await clickLive(page, c, again);
      if (!r3.ok) throw new Error(r3.why);
    } catch {
      page.off('pageerror', onErr); page.off('response', onRes); page.off('request', onReq);
      return { verdict: 'UNREACHABLE', why: e.message.split('\n')[0].slice(0, 120) };
    }
  }

  await sleep(700);
  const after = await fingerprint(page).catch(() => before);
  page.off('pageerror', onErr);
  page.off('response', onRes);
  page.off('request', onReq);

  // ── The platform's own rate limiter, correctly refusing us ──────────────
  // `RATE_LIMIT_TIERS.global` is 1,000 requests per 15 minutes per IP, and a
  // pass that presses 1,400 controls goes through that. The limiter is right;
  // the harness was wrong to read its refusal as a verdict on the control. It
  // is also not something to weaken for a test — production behaviour is what
  // is under test — so this waits, the way any well-behaved client would, and
  // the control is reported as never actually reached.
  if (throttled.length) {
    await sleep(THROTTLE_PAUSE_MS);
    return { verdict: 'THROTTLED', why: 'the platform rate-limited this request (429) — not the control\'s fault' };
  }
  if (errors.length) return { verdict: 'THREW', why: errors[0].slice(0, 200), acted };
  if (failed.length) return { verdict: 'FIVE_HUNDRED', why: failed.join(' | ').slice(0, 200), acted };
  if (!changed(before, after)) {
    if (asked !== (page.__bbAsked ?? 0)) {
      return { verdict: 'NEEDS_INPUT', acted, why: 'it asked a confirm/prompt, which this pass declines' };
    }
    /**
     * ── A Refresh button is not dead because the data did not change ───────
     * Nearly every screen here has a Refresh, and on a quiet database it
     * refetches the same rows and repaints them identically — so the
     * fingerprint (text, values, checked, aria, markup) is unmoved and the
     * pass filed it as INERT. That is the harness accusing a working control,
     * and it was doing it on nine screens at once.
     *
     * What separates the two is not the SCREEN, it is the WIRE. S22 is a
     * control with NO handler: it calls nothing at all. A working Refresh
     * issues a request. So a press that moved nothing but spoke to the server
     * is REFETCHED — it did its job, the answer was the same — and INERT is
     * reserved for a control that changed nothing and asked for nothing,
     * which is the shape actually worth hunting.
     */
    /**
     * ── The segment that is already selected ──────────────────────────────
     * `All` on the merchant's order filter and `Volume` on its history tabs
     * are the DEFAULT segments. Pressing the one already chosen correctly
     * changes nothing, and the pass called both dead buttons.
     *
     * The control says so itself — `aria-pressed`/`aria-selected` was read at
     * collection — so this is not a guess about the name. It is also the same
     * fact a screen reader announces, which is why S24's labelling work and
     * this share a cause: state a control does not publish is state nothing
     * can check.
     */
    if (c.on) {
      return { verdict: 'ALREADY_ON', acted, why: 'it was already the selected one — pressing it again correctly changes nothing' };
    }
    if (calls.length) {
      return { verdict: 'REFETCHED', acted, why: `no visible change, but it called ${calls[0]}${calls.length > 1 ? ` (+${calls.length - 1} more)` : ''}` };
    }
    return { verdict: 'INERT', acted, why: 'it changed nothing on screen AND called no route — nothing happened at all (S22)' };
  }
  return { verdict: 'ACTED', acted, moved: moved(before, after).join(',') };
}

/**
 * Put the screen back the way it was found.
 *
 * A press can open a dialog, switch a tab, or navigate. The next control's
 * triple was taken from the ORIGINAL screen, so it has to be the original
 * screen again — otherwise the pass drifts into whatever the last click opened
 * and silently stops testing the screen it names.
 */
async function reset(page, cfg, screen, base) {
  await page.keyboard.press('Escape').catch(() => {});
  await navigate(page, cfg, '/__bb_reset_never_matches__', base).catch(() => {});
  await sleep(150);
  await navigate(page, cfg, screen, base).catch(() => {});
  await settle(page, 8000);
}

// ── Run ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const onlyPanels  = args.filter((a) => a.endsWith('-panel'));
const onlyScreens = args.filter((a) => a.startsWith('/'));

// `/health/live`, not `/api/v1/system/config`. The config route is rate
// limited — correctly — and a 500ms poll plus a pass that drives 1,700 controls
// through it looks exactly like abuse, so the probe was answered 429 and the
// harness concluded the server was down. The liveness endpoint exists for this.
if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);

// ₹5,000 — a real ATM denomination, so `/cash-links` renders its working
// screen instead of the "not approved for the ATM cash rail" empty state.
// Without it the whole CASH_ATM supply side is never opened by this pass.
const theMerchant = await seedMerchant({
  currency: 'INR', tokensPaise: 500000000, cashDenominationPaise: 500000,
});

const actors = {
  'user-panel':     playerToken(await seedPlayer({ balancePaise: 150000 })),
  'admin-panel':    adminToken(await seedAdmin()),
  'merchant-panel': merchantToken(theMerchant),
};

/** What each panel would have cached from this operator's last visit. */
const cached = {
  'merchant-panel': {
    id: theMerchant.merchantId, merchantId: theMerchant.merchantId,
    username: theMerchant.username, email: theMerchant.email, mobile: theMerchant.mobile,
    isOnline: true, status: 'ACTIVE', acceptedCurrencies: ['INR'],
  },
};

mkdirSync(SHOTS, { recursive: true });

/**
 * ── The report MERGES; it does not overwrite ──────────────────────────────
 * A filtered run (`test:drive -- admin-panel /kyc`) used to replace the whole
 * file, so every screen it did not touch silently became "NOT DRIVEN" — and the
 * coverage report read that as work still to do. It nearly had me publish a
 * table saying the merchant panel had never been driven, hours after driving
 * all seven of its screens.
 *
 * So a run replaces only the screens it actually drove, and every screen
 * carries its OWN timestamp. A re-run of one screen updates that screen and
 * leaves the rest standing, and the report can say how old each result is
 * rather than pretending they are all from one moment.
 */
const previous = (() => {
  try { return JSON.parse(readFileSync(REPORT, 'utf8')); } catch { return { pressed: [] }; }
})();
const report = { takenAt: new Date().toISOString(), pressed: [...(previous.pressed ?? [])] };
/** Screens this run drove, so their old results can be dropped. */
const drovenow = new Set();
const tally = {};
const bump = (v) => { tally[v] = (tally[v] ?? 0) + 1; };

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'], headless: !process.env.BB_HEADED });

try {
  for (const { panel, screens } of panelScreens()) {
    if (onlyPanels.length && !onlyPanels.includes(panel)) continue;
    const cfg = PANELS[panel];
    const base = `http://127.0.0.1:${cfg.port}`;
    const { log } = startVite(panel, cfg.port);
    const probe = `${base}${panel === 'user-panel' ? '/' : `/${panel.split('-')[0]}/`}`;
    if (!await waitFor(probe, `${panel}'s dev server`)) {
      check('DRIVE', panel, 'the dev server starts', 'listening', log.join('').slice(-300), false);
      continue;
    }

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(([k, v, extraKey, extraVal]) => {
      try {
        localStorage.setItem(k, v);
        // A REAL returning operator has more than a token: the panel cached
        // their profile last visit. Seeding only the token meant that the
        // moment the profile call was refused — which it was, every full run,
        // because this panel is driven last and the global limiter is 1,000
        // req / 15 min per IP — the panel had nothing to fall back on and
        // rendered its sign-in screen for all seven screens.
        if (extraKey) localStorage.setItem(extraKey, extraVal);
      } catch { /* blocked */ }
    }, [cfg.key, cfg.wrap(actors[panel]), cfg.cacheKey ?? '', cfg.cacheKey ? JSON.stringify(cached[panel]) : '']);
    await ctx.addInitScript(PAGE_SCRIPT);
    // A confirm() that nobody answers blocks the page for ever. Auto-dismiss:
    // this pass never presses a control whose confirm it would want to accept.
    const page = await ctx.newPage();
    // A confirm() or prompt() nobody answers blocks the page for ever, so they
    // are dismissed — and REMEMBERED, because a control that asked a question
    // and was told no did not do nothing, it was declined. Reporting that as
    // INERT would send somebody hunting a dead button that works.
    page.on('dialog', (d) => { page.__bbAsked = (page.__bbAsked ?? 0) + 1; d.dismiss().catch(() => {}); });
    /**
     * ── A 429 during a screen's OWN load voids that screen ─────────────────
     * The merchant panel is driven last, after ~1,600 presses have gone
     * through one IP, and `RATE_LIMIT_TIERS.global` is 1,000 per 15 minutes.
     * So `/api/merchant/profile` came back **429**, the panel rendered without
     * a profile, and six of its seven screens collected zero controls — which
     * the pass then reported as `ok`.
     *
     * A refusal the harness provoked is not a result about the product. Count
     * them per screen so the verdict can say the screen was never measured.
     */
    page.on('response', (r) => {
      if (r.status() === 429) page.__bb429 = (page.__bb429 ?? 0) + 1;
    });

    await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, 30000);

    for (const screen of screens) {
      if (onlyScreens.length && !onlyScreens.includes(screen)) continue;
      await navigate(page, cfg, screen, base);
      await settle(page);

      page.__bb429 = 0;
      const controls = await collect(page).catch(() => []);
      // What `<main>` SAYS, for the no-controls verdict below. A screen with
      // nothing to press is either a shell that failed or an empty state that
      // explains itself, and only the text tells the two apart.
      const said = await page.evaluate(() => {
        const m = document.querySelector('main');
        return ((m || document.body).innerText || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      /**
       * ── Is this the screen we asked for, or the door? ──────────────────────
       * A full run drives the merchant panel LAST, after ~1,700 presses have
       * gone through one IP, so its profile call was 429'd and the panel fell
       * back to its sign-in screen. The pass then collected the LOGIN FORM's
       * five controls and filed them under `/dashboard`, `/orders`,
       * `/cash-links` and the rest — seven screens' worth of results, every one
       * measured on a screen nobody asked for. Results attributed to the wrong
       * screen are worse than no results, because the coverage table counts
       * them as pressed.
       *
       * ── The first version of this check read PROSE, and accused three
       * working screens ───────────────────────────────────────────────────────
       * It matched /sign[- ]?in|secure operator/ against `<main>`'s text, and
       * on its first full run failed `admin /settings` (75 real settings
       * controls), `admin /telegram` (28 real config controls) and
       * `user /referrals` — none of which is a login screen; they merely
       * contain those words, which is what a settings screen full of sign-in
       * options WOULD contain. A gate that reads prose will eventually read it
       * wrong (trap 11), and a false failure is how a gate loses its authority
       * and gets switched off (§28).
       *
       * So it asks the ROUTER instead, which is the thing that actually decides
       * which screen is mounted. If the panel bounced us somewhere else, its
       * own location says so — no wording involved, and a screen cannot talk
       * its way into or out of the verdict.
       */
      const where = await page.evaluate((isHash) => (isHash
        ? (location.hash || '').replace(/^#/, '')
        : location.pathname), cfg.router === 'hash').catch(() => null);
      const asked = cfg.router === 'hash' ? screen : `${cfg.base ?? ''}${screen}`;
      const norm = (x) => String(x ?? '').replace(/\/+$/, '') || '/';
      const atTheDoor = where !== null && norm(where) !== norm(asked);
      // This screen is being driven now, so whatever a previous run recorded
      // for it is superseded rather than added to.
      const key = `${panel}\u0000${screen}`;
      if (!drovenow.has(key)) {
        drovenow.add(key);
        for (let i = report.pressed.length - 1; i >= 0; i--) {
          const p = report.pressed[i];
          if (p.panel === panel && p.screen === screen) report.pressed.splice(i, 1);
        }
      }
      const seen = new Set();
      const byName = new Map();
      const results = [];

      for (const c of controls) {
        // One control must not be able to end the pass. A press can navigate,
        // close the context, or wedge the page; the verdict for THAT control is
        // the failure, and the other 1,700 still deserve to be pressed.
        let r;
        try {
          r = await press(page, panel, screen, c, seen, byName);
        } catch (e) {
          r = { verdict: 'UNREACHABLE', why: `pressing it broke the pass: ${e.message.split('\n')[0].slice(0, 120)}` };
        }
        bump(r.verdict);
        results.push({ control: idOf(panel, screen, c), ...r });
        report.pressed.push({ panel, screen, at: report.takenAt, kind: c.kind, name: c.name, ordinal: c.ordinal, ...r });

        // Go back when the press moved the screen STRUCTURALLY — a dialog
        // opened, the control count changed, or it navigated. The next
        // control's triple was taken from the original screen, so it has to be
        // the original screen again. A press that only changed some text has
        // not invalidated anything, and resetting on every one of 1,400 presses
        // would add half an hour of navigation for nothing.
        const structural = /dialogs|controls|hash|path/.test(r.moved ?? '');
        if (structural || r.verdict === 'THREW' || r.verdict === 'FIVE_HUNDRED' || r.verdict === 'UNREACHABLE') {
          await reset(page, cfg, screen, base);
        }
      }

      const throttledOut = results.filter((r) => r.verdict === 'THROTTLED');
      const broke  = results.filter((r) => r.verdict === 'THREW' || r.verdict === 'FIVE_HUNDRED');
      const inert  = results.filter((r) => r.verdict === 'INERT');
      const gone   = results.filter((r) => r.verdict === 'GONE' || r.verdict === 'UNREACHABLE');
      const acted  = results.filter((r) => r.verdict === 'ACTED').length;
      // A control that called a route and got the same answer back DID something.
      const refetched = results.filter((r) => r.verdict === 'REFETCHED').length;
      const defer  = results.filter((r) => r.verdict === 'DEFERRED').length;
      const repr   = results.filter((r) => r.verdict === 'REPRESENTED').length;
      const shape  = `${controls.length} controls: ${acted} acted`
        + `${refetched ? `, ${refetched} refetched (called a route, same answer)` : ''}`
        + `, ${inert.length} inert, ${defer} deferred`
        + `, ${gone.length} unreachable${repr ? `, ${repr} repeats of one already pressed` : ''}`;

      /**
       * ── Zero controls is a FAILURE, never a pass ───────────────────────────
       * This branch is the whole reason the merchant panel read green on a run
       * that never opened it. `0 controls: 0 acted, 0 inert, 0 deferred` fell
       * through every case below and landed on `check(..., true)` — a screen
       * with nothing to press satisfied "every control pressed, all responded"
       * VACUOUSLY, and six screens passed on having measured nothing.
       *
       * That is §29 in the harness itself: absence of a failing check read as
       * evidence, and S8 — a gate measuring a fraction, reported green. Every
       * screen in this platform has at least one control; zero means the screen
       * rendered only its shell (S21), the router never arrived, or the pass was
       * refused at the door. None of those is a pass.
       */
      if (!controls.length) {
        await page.screenshot({ path: join(SHOTS, `${panel}${screen.replace(/\//g, '_') || '_root'}.png`) }).catch(() => {});
        if (page.__bb429) {
          check('DRIVE', panel, screen, 'the screen was actually measured',
            `NOTHING TO PRESS — the platform answered 429 ${page.__bb429}x while this screen loaded, so it `
            + 'never rendered. NOT verified; re-run this screen on its own.', false,
            'the harness provoked the refusal; this says nothing about the product');
        } else if (atTheDoor) {
          check('DRIVE', panel, screen, 'this is the screen that was asked for',
            `NOT VERIFIED — the panel routed to ${JSON.stringify(where)} instead of `
            + `${JSON.stringify(asked)}, so nothing here describes the screen that was asked for.`,
            false, 'read from the panel\'s own router after the screen settled');
        } else if (said.length < EMPTY_STATE_MIN_CHARS) {
          // A shell. `<main>` rendered, and rendered nothing — the S21 shape,
          // and exactly what sixteen admin screens looked like earlier in this
          // review when the harness, not the app, was at fault.
          check('DRIVE', panel, screen, 'the screen renders its content',
            `NOTHING TO PRESS and <main> says ${said ? JSON.stringify(said) : 'NOTHING'} — a shell (S21), `
            + 'or the pass never reached it. Open it in a browser before believing either.', false,
            'measured inside <main>, after the screen settled');
        } else {
          // An empty state that EXPLAINS itself is a working screen. The
          // merchant cash-links screen is the case that taught this: no
          // controls, because the account is not approved for the ATM rail,
          // and a sentence saying so and naming who fixes it. Failing that
          // would be the harness accusing correct code again — so the verdict
          // records the SENTENCE, for a person to judge (§14/S14).
          note('DRIVE', panel, screen, 'nothing to press, and the screen says why',
            `0 controls — an empty state, not a shell`, said.slice(0, 220));
        }
      } else if (atTheDoor) {
        // Five controls were collected and every one of them belongs to the
        // sign-in form. Reporting them under this screen's name is how seven
        // merchant screens read as driven while none had been opened.
        await page.screenshot({ path: join(SHOTS, `${panel}${screen.replace(/\//g, '_') || '_root'}.png`) }).catch(() => {});
        check('DRIVE', panel, screen, 'this is the screen that was asked for',
          `NOT VERIFIED — ${controls.length} controls were collected, but the panel routed to `
          + `${JSON.stringify(where)} instead of ${JSON.stringify(asked)}. They describe that screen, not this one.`,
          false, 'read from the panel\'s own router after the screen settled');
      } else if (broke.length) {
        check('DRIVE', panel, screen, 'no control throws or 5xxes', 
          broke.map((b) => `${b.control} → ${b.verdict}: ${b.why}`).slice(0, 3).join('  ||  '), false,
          'pressed as a person would; the screen was re-read before and after each press');
        await page.screenshot({ path: join(SHOTS, `${panel}${screen.replace(/\//g, '_') || '_root'}.png`) }).catch(() => {});
      } else if (throttledOut.length) {
        note('DRIVE', panel, screen, 'every control actually reached', shape,
          `${throttledOut.length} never reached — the platform rate-limited the run (429). `
          + 'Re-run this screen on its own; these are NOT verified.');
      } else if (gone.length) {
        note('DRIVE', panel, screen, 'every control reachable', shape,
          gone.map((g) => `${g.control}: ${g.why}`).slice(0, 2).join(' | '));
      } else if (inert.length) {
        note('DRIVE', panel, screen, 'every control does something', shape,
          `inert (text, field values, checked, aria state and markup length all unmoved): `
          + inert.map((i) => i.control.split('#')[1]).slice(0, 6).join(', '));
      } else {
        check('DRIVE', panel, screen, 'every control pressed, all responded', shape, true);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stopAll();
}

writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(`\n${'─'.repeat(78)}\nCONTROLS PRESSED\n`);
for (const [v, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${v}`);
}
const total = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(`  ${String(total).padStart(4)}  TOTAL\nReport: ${REPORT}`);

const { failed: failures } = summary();
process.exit(failures ? 1 : 0);

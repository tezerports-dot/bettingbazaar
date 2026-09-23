// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The stack a browser pass runs against, and the moving parts every pass needs.
 *
 * ── Why this is its own file ───────────────────────────────────────────────
 * `drive.js` presses every control; `forms.js` submits every form empty and
 * out of range. They ask different questions of the same three panels, and
 * everything BELOW that question is identical: which port each panel is on,
 * how a session is installed, starting the dev servers, navigating inside a
 * SPA that a press may have navigated away from, waiting for a screen to stop
 * moving, putting it back, and waiting out the platform's rate limiter.
 *
 * Copying that into a second pass would be §5 exactly: the same thing
 * assembled twice, drifting silently. Every hard-won correction lives here
 * once — the settle that watches control COUNT as well as text, the navigate
 * that survives "Execution context was destroyed", the budget wait that stops
 * a pass measuring screens the platform has stopped answering.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { seedPlayer, seedMerchant, seedAdmin } from '../e2e/seed.js';
import { playerToken, merchantToken, adminToken } from '../e2e/harness.js';

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const API = process.env.BB_BASE ?? 'http://127.0.0.1:8099';
export const EXECUTABLE = process.env.BB_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export const PANELS = {
  'user-panel':     { port: 5301, entry: (b) => `${b}/#/`,        router: 'hash',    key: 'auth_token',    wrap: (t) => t },
  'admin-panel':    { port: 5302, entry: (b) => `${b}/admin/#/`,  router: 'hash',    key: 'admin-auth',
    wrap: (t) => JSON.stringify({ state: { token: t, admin: null, isAuthenticated: true, mustEnroll2FA: false }, version: 0 }) },
  'merchant-panel': { port: 5303, entry: (b) => `${b}/merchant/`, router: 'history', base: '/merchant', key: 'merchantToken', wrap: (t) => t, cacheKey: 'merchantData' },
};


export const children = [];
export const stopAll = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

export async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await sleep(500);
  }
  console.error(`${label} never answered at ${url}`);
  return false;
}

export function startVite(panel, port) {
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
export async function navigate(page, cfg, screen, base) {
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
export async function settle(page, ms = 15000) {
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


export const IGNORE = [/favicon\.ico/i, /\/@vite\/client/, /\[vite\]/, /Download the React DevTools/i];
export const ignored = (s) => IGNORE.some((re) => re.test(String(s)));

/**
 * Put the screen back the way it was found.
 *
 * A press can open a dialog, switch a tab, or navigate. The next control's
 * triple was taken from the ORIGINAL screen, so it has to be the original
 * screen again — otherwise the pass drifts into whatever the last click opened
 * and silently stops testing the screen it names.
 */
export async function reset(page, cfg, screen, base) {
  await page.keyboard.press('Escape').catch(() => {});
  await navigate(page, cfg, '/__bb_reset_never_matches__', base).catch(() => {});
  await sleep(150);
  await navigate(page, cfg, screen, base).catch(() => {});
  await settle(page, 8000);
}

/**
 * Wait until the platform has budget for this screen.
 *
 * ── Why a pass that presses everything has to do this ──────────────────────
 * `RATE_LIMIT_TIERS.global` is 1,000 requests per 15 minutes per IP. A full
 * drive of 68 screens and ~1,700 controls makes several times that, so from
 * some point onward every request is refused — and a screen whose data was
 * refused still RENDERS, just empty. The pass then measures the empty version
 * and reports it as coverage.
 *
 * That is exactly what the run before this one did. `/game-providers`
 * collected 3 controls instead of 147, `/chat-management` reported a tidy
 * "No support tickets yet" empty state, `/payment-control` rendered nothing at
 * all — and the coverage table read 451 controls NOT REACHED against 177 in
 * the run before, with nothing between them that touched a panel. Every one of
 * those screens works; the platform had simply stopped answering us.
 *
 * The limiter is right, and it is production behaviour that must not be
 * weakened to make a test pass (§29). So the pass does what any well-behaved
 * client does: it reads the budget the server publishes and waits for the
 * window to roll over before it starts a screen it could not finish.
 *
 * One request per screen to ask, which is cheaper than a screen's worth of
 * results that describe nothing.
 */
export const BUDGET_FLOOR = Number(process.env.BB_BUDGET_FLOOR ?? 120);
export async function awaitBudget(label) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let left = null, resetIn = 15;
    try {
      const r = await fetch(`${API}/api/v1/system/config`, { method: 'GET' });
      left = Number(r.headers.get('ratelimit-remaining'));
      resetIn = Number(r.headers.get('ratelimit-reset') ?? 15);
    } catch { return; }           // server unreachable is a different problem
    if (!Number.isFinite(left) || left > BUDGET_FLOOR) return;
    const wait = Math.min(Math.max(resetIn, 1), 900) + 2;
    console.log(`   … ${label}: ${left} requests left in the window — waiting ${wait}s for it to roll over`);
    await sleep(wait * 1000);
  }
}



/**
 * Seed one actor per panel and hand back the session each one installs.
 *
 * Two things here are not obvious and both were paid for:
 *
 *   `cashDenominationPaise` makes the merchant a CASH merchant, so
 *   `/cash-links` renders its working screen instead of the "not approved for
 *   the ATM cash rail" empty state. Without it the whole CASH_ATM supply side
 *   is never opened by anything that clicks.
 *
 *   `cached` is what a RETURNING operator has in localStorage besides a token.
 *   Seeding only the token meant that the moment a profile call was refused —
 *   which happened on every full run, because the merchant panel is driven
 *   last — the panel had nothing to fall back on and rendered its sign-in
 *   screen for all seven screens.
 */
export async function seedActors() {
  const theMerchant = await seedMerchant({
    currency: 'INR', tokensPaise: 500000000, cashDenominationPaise: 500000,
  });
  return {
    actors: {
      'user-panel':     playerToken(await seedPlayer({ balancePaise: 150000 })),
      'admin-panel':    adminToken(await seedAdmin()),
      'merchant-panel': merchantToken(theMerchant),
    },
    cached: {
      'merchant-panel': {
        id: theMerchant.merchantId, merchantId: theMerchant.merchantId,
        username: theMerchant.username, email: theMerchant.email, mobile: theMerchant.mobile,
        isOnline: true, status: 'ACTIVE', acceptedCurrencies: ['INR'],
      },
    },
  };
}

/**
 * Turn on one provider per category, and hand back a restore.
 *
 * `/crash` and `/sports` redirect to `/` when their category has no enabled
 * provider — correct behaviour, and it means those screens are never opened by
 * anything that clicks unless the pass arranges for them to exist. Reading
 * whatever the database happens to hold is S19. The restore goes in a
 * `finally`, outside any assertion, because a pass that leaves its fixtures
 * behind is trap 10 — and these rows decide what every player sees.
 */
export async function enableGameProviders(keys = ['spribe', 'betby']) {
  const { pgQuery } = await import('#db/client.js');
  const { rows } = await pgQuery(
    'SELECT provider_key, enabled, api_url FROM game_providers WHERE provider_key = ANY($1)', [keys],
  );
  for (const key of keys) {
    // `game_providers_enabled_has_url` refuses an enabled provider with no URL,
    // so both columns move together.
    await pgQuery('UPDATE game_providers SET enabled = TRUE, api_url = $2 WHERE provider_key = $1',
      [key, `https://${key}.drive.invalid`]);
  }
  return async () => {
    for (const r of rows) {
      await pgQuery('UPDATE game_providers SET enabled = $2, api_url = $3 WHERE provider_key = $1',
        [r.provider_key, r.enabled, r.api_url]);
    }
  };
}

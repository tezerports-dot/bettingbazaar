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
import { seedPlayer, seedMerchant, seedTeam, seedAdmin } from '../e2e/seed.js';
import { playerToken, merchantToken, adminToken } from '../e2e/harness.js';

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const API = process.env.BB_BASE ?? 'http://127.0.0.1:8099';
export const EXECUTABLE = process.env.BB_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export const PANELS = {
  'user-panel':     { port: 5301, entry: (b) => `${b}/#/`,        router: 'hash',    key: 'auth_token',    wrap: (t) => t },
  // ── `admin` is NOT null, and that is the whole difference ───────────────
  // `AdminOnly` and `PermRoute` in the admin panel's App.tsx ask two questions
  // — `isAuthenticated`, then `admin?.isAdmin` — and a null `admin` fails the
  // second, so the guard fires `<Navigate to="/login" replace>` on the FIRST
  // paint. `verifySession()` fills `admin` a moment later and nothing
  // navigates back, so the pass sat on the sign-in screen for all 44 screens
  // while localStorage plainly said `isAuthenticated: true` with a live token.
  //
  // MEASURED 5 out of 5 boots. The seeded envelope described a state the
  // product cannot produce (§32 S16): a real admin gets `admin` at login and
  // it is persisted by `partialize`, so on reload it is never null. Seeding
  // only the token was the merchant panel's `cacheKey` lesson — "a REAL
  // returning operator has more than a token" — left unapplied to this panel.
  'admin-panel':    { port: 5302, entry: (b) => `${b}/admin/#/`,  router: 'hash',    key: 'admin-auth',
    wrap: (t, who) => JSON.stringify({
      state: { token: t, admin: who ?? null, isAuthenticated: true, mustEnroll2FA: false }, version: 0,
    }) },
  'merchant-panel': { port: 5303, entry: (b) => `${b}/merchant/`, router: 'history', base: '/merchant', key: 'merchantToken', wrap: (t) => t, cacheKey: 'merchantData' },
};


export const children = [];
/**
 * Stop every dev server this pass started — and mean it.
 *
 * SIGTERM is not enough and that was measured: after a full inventory exited 0,
 * all three vite servers were still listening more than two minutes later.
 * Vite's dev server holds open HMR websockets and takes its time; the pass is
 * already gone by then.
 *
 * The consequence is not untidiness. `--strictPort` means the NEXT pass's own
 * vite fails to bind, `waitFor` is answered by the survivor, and the pass
 * measures a dev server it did not start — §32 S33, moved to the front end.
 *
 * SIGKILL, therefore. A dev server has no state to flush, and the guarantee
 * this function exists to make is worth more than a graceful close.
 */
export const stopAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
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

/**
 * Start the panel's dev server — and be able to STOP it again.
 *
 * ── Why the panel's own binary, and not `npx vite` ────────────────────────
 * `npx vite` is three processes: npx, an `sh -c`, and the node that actually
 * binds the port. `stopAll` SIGTERMs the one it spawned — npx — and the
 * grandchild that holds the socket survives. Measured: dev servers 17 and 19
 * MINUTES old were still listening on 5301 and 5303 after the passes that
 * started them had exited.
 *
 * That is not untidiness, it is §32 S33 moved to the front end. `--strictPort`
 * means the NEXT pass's own vite fails to bind, `waitFor` is answered by the
 * survivor, and the pass measures a dev server it did not start — serving
 * whatever source tree that older process had loaded.
 *
 * Spawning `<panel>/node_modules/.bin/vite` removes both wrapper layers, so
 * the child this function returns IS the server, and killing it kills it.
 */
export function startVite(panel, port) {
  const child = spawn(join(ROOT, panel, 'node_modules/.bin/vite'),
    ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
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


/**
 * Boot the panel, and REFUSE to measure one that booted logged out.
 *
 * ── Why the boot is the one moment that must not be refused ───────────────
 * `awaitBudget` guarded each SCREEN and not the boot, which is backwards: a
 * screen refused mid-pass renders empty and is reported empty, but the BOOT is
 * where every panel decides whether it still has a session. Refuse that one
 * request and the panel renders its sign-in screen — and the pass never boots
 * again, so every screen after it is the sign-in screen too.
 *
 * MEASURED, and it is why this exists: a drive of the 44 admin screens started
 * straight after the inventory had spent the window (`RATE_LIMIT_TIERS.global`
 * is 1,000 requests / 15 min per IP). It ran eleven minutes, pressed SIX
 * controls on ONE screen — `/login` — and reported nine screens as
 * "NOTHING TO PRESS and <main> says NOTHING", against an inventory taken four
 * minutes earlier that had found 1,053 controls across all 44. Every one of
 * those findings was false, specific and confident, which is §29's own
 * warning and §28's "a gate whose failure mode is silence reports the author".
 *
 * So: wait for budget BEFORE the boot, and then check the thing that actually
 * went wrong rather than trusting that it did not. A password field in the
 * routed region means this pass is looking at a sign-in screen, whatever the
 * token said, and nothing measured after that describes the product.
 */
export async function boot(page, cfg, base, panel) {
  await awaitBudget(`${panel} boot`);
  await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 30000);
  // WHAT it is showing, not just whether. A refusal nobody can see is a
  // refusal nobody can act on — and a guard that reports the wrong thing is
  // how a gate loses its authority and gets switched off (§28).
  const seen = await page.evaluate(() => {
    const root = document.querySelector('main') ?? document.body;
    return {
      password: Boolean(root?.querySelector('input[type="password"]')),
      heading: document.querySelector('h1, h2')?.textContent?.trim().slice(0, 80) ?? '',
      text: root?.innerText?.trim().slice(0, 200) ?? '',
    };
  }).catch(() => ({ password: false, heading: '', text: '' }));
  return { signedOut: seen.password, seen };
}

/**
 * Click what a PERSON clicks, when the control itself cannot take a click.
 *
 * A styled toggle is an `<input type="checkbox" class="sr-only">` inside a
 * `<label>`, with a `<div>` drawn as the switch. The input is a real control
 * with a real accessible name and a real `onChange`, and it is also invisible,
 * so a direct click waits for a node that will never be visible and times out.
 *
 * Two passes hit this independently — `drive.js` reported seven toggles
 * UNREACHABLE, and `mutate.js` could not flip the merchant's notification
 * switch, so its Save stayed disabled and the case failed on the SAVE while
 * the real cause was the switch above it. One shape, two symptoms, so one
 * owner (§5).
 *
 * Two rules it must keep:
 *
 *   Only on a TIMEOUT. "Something is on top of this" is the screen's business
 *   and a real finding; reaching round it by clicking the label would hide
 *   exactly the defect worth having.
 *
 *   No guess about visibility. The first draft tested `getClientRects()`, and
 *   Tailwind's `sr-only` keeps a 1x1 rect — so it judged all seven toggles
 *   visible and never ran. The failed click IS the evidence.
 */
export async function clickThrough(el, opts = {}) {
  try {
    await el.click({ timeout: 4000, ...opts });
    return { ok: true };
  } catch (e) {
    if (!/Timeout .* exceeded/i.test(e.message)) return { ok: false, why: e.message.split('\n')[0] };
    const proxy = await el.evaluateHandle((n) => {
      const byFor = n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null;
      return byFor ?? n.closest('label');
    }).then((h) => h.asElement()).catch(() => null);
    if (!proxy) return { ok: false, why: e.message.split('\n')[0] };
    try {
      await proxy.click({ timeout: 4000, ...opts });
      return { ok: true, via: 'its label' };
    } catch (e2) {
      return { ok: false, why: e2.message.split('\n')[0] };
    }
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
    let left, resetIn;
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
 * A configured platform: the one Mini App bot exists (Step 3).
 *
 * Without it the panels offer no Telegram buttons and staff sign in under the
 * bootstrap exemption, so a pass over an unconfigured database would measure
 * a platform nobody runs (§32 S19: a pass that needs a value SETS it). The
 * seeded actors are already verified (`seed.verifyActor`), so nothing here
 * blocks a screen.
 *
 * The bot is the test token (`miniAppFixture`), written through the repository
 * because the admin route asks Telegram's `getMe` and there is no Telegram
 * here. Restored in the caller's `finally` (trap 10): a bot this pass did not
 * find is removed again, one it found is left alone.
 */
export async function configureTelegram() {
  const { pgQuery } = await import('#db/client.js');
  const { saveTestBot, removeTestBot } = await import('../miniAppFixture.js');
  const before = await pgQuery('SELECT 1 FROM telegram_bot', [], 'drive_tg_before');
  if (before.rows.length) return async () => {};
  await saveTestBot();
  return async () => { await removeTestBot(); };
}

/**
 * Seed one actor per panel and hand back the session each one installs.
 *
 * Two things here are not obvious and both were paid for:
 *
 *   The merchant is a MEMBER of a working CASH team (Step 2c: a merchant is
 *   on a rail only through a team), so the Dashboard renders the cash
 *   member's Ready switch instead of leaving it out. Without that the whole
 *   cash side of the merchant panel is never opened by anything that clicks.
 *
 *   `cached` is what a RETURNING operator has in localStorage besides a token.
 *   Seeding only the token meant that the moment a profile call was refused —
 *   which happened on every full run, because the merchant panel is driven
 *   last — the panel had nothing to fall back on and rendered its sign-in
 *   screen for all seven screens.
 */
export async function seedActors() {
  // Telegram FIRST, and inside this function rather than at each call site.
  // `verifyActor` needs a live generation for the actor's own audience, so an
  // actor seeded before the channel exists is silently left unverified — and
  // the symptom is not an error, it is a modal over every screen. A pass that
  // has to remember to call two things in order is a pass that will one day
  // call one; there is nothing to forget if the seeding owns both.
  const restoreTelegram = await configureTelegram();
  const theMerchant = await seedMerchant({ currency: 'INR' });
  await seedTeam({ rail: 'CASH', poolTokens: 10000, include: [theMerchant], online: [theMerchant] });
  const theAdmin = await seedAdmin();
  return {
    restore: restoreTelegram,
    actors: {
      'user-panel':     playerToken(await seedPlayer({ balancePaise: 150000 })),
      'admin-panel':    adminToken(theAdmin),
      'merchant-panel': merchantToken(theMerchant),
    },
    cached: {
      // What `/api/v1/auth/me` hands the admin panel, which `partialize`
      // persists — so a returning admin has it before the first paint, and
      // the route guards do not bounce them to the sign-in screen.
      'admin-panel': {
        id: theAdmin.userId, _id: theAdmin.userId, userId: theAdmin.userId,
        username: theAdmin.username ?? theAdmin.userId, mobile: theAdmin.mobile,
        isAdmin: true, isSubAdmin: false, isQueueManager: true, permissions: {},
      },
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
  // ── The rows have to EXIST before they can be switched on ──────────────
  // The server creates the provider rows lazily, on the first
  // `GET /api/game/providers`. On a database nothing has asked yet, the
  // UPDATE below matched no rows, said nothing, and every browser pass on a
  // fresh database inventoried `/crash` and `/sports` as the board they
  // redirect to — measured 2026-10-01, when a fresh `bb_drive` produced a
  // default manifest with no crash or sports screen in it at all. So the pass
  // asks the server first, and refuses to go on if a row still did not move.
  await fetch(`${API}/api/game/providers`).catch(() => {});
  const { rows } = await pgQuery(
    'SELECT provider_key, enabled, api_url FROM game_providers WHERE provider_key = ANY($1)', [keys],
  );
  for (const key of keys) {
    // `game_providers_enabled_has_url` refuses an enabled provider with no URL,
    // so both columns move together.
    const { rowCount } = await pgQuery('UPDATE game_providers SET enabled = TRUE, api_url = $2 WHERE provider_key = $1',
      [key, `https://${key}.drive.invalid`]);
    if (rowCount !== 1) {
      throw new Error(`enableGameProviders: no game_providers row for "${key}" — the crash and sports screens would be inventoried as the board they redirect to`);
    }
  }
  return async () => {
    for (const r of rows) {
      await pgQuery('UPDATE game_providers SET enabled = $2, api_url = $3 WHERE provider_key = $1',
        [r.provider_key, r.enabled, r.api_url]);
    }
  };
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Sign up, verify, and sign in — typed into a real browser, as a player.
 *
 * ── Why this pass exists, and what it can see that nothing else can ────────
 * Every tier below a browser was green for the two defects this change
 * produced, and one of them was only visible by TYPING:
 *
 *   · `+91 98765 43210` into a box with `+91` printed beside it landed as
 *     `9198765432` — ten digits, starting with a 9, plausible to every check on
 *     both sides. The account would be created on a number that is not the
 *     player's, the Telegram contact share would then match nothing forever,
 *     and `users.mobile` is never mutable. A route test cannot see it: it posts
 *     the value it meant. A component test caught it only because it types
 *     character by character, which is what a person does.
 *
 *   · `GET /me` answering 429 from an address that had submitted no
 *     credential, because a subnet limiter sat on a router prefix. Invisible to
 *     a suite that mounts the router directly.
 *
 * So this presses the real controls, on the real origin, against a real
 * server and a real database, and asserts the ROWS afterwards — not the
 * screen's own account of itself.
 *
 * ── What it cannot cover, stated plainly (§29) ────────────────────────────
 * The CAPTCHA. `requireCaptcha` is a pass-through with no
 * TURNSTILE_SECRET_KEY, which is how it ships and how any deployment that has
 * not configured Turnstile runs it. There is no secret key in this repository
 * and there cannot be one, so no automated tier here exercises a real
 * challenge — the captcha path is UNTESTED and this pass does not imply
 * otherwise.
 *
 *   node backend/tests/browser/signupJourney.js
 */
import { chromium } from 'playwright-core';
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite, settle } from './stack.js';
import { pgQuery } from '#db/client.js';

const cfg = PANELS['user-panel'];
const BASE = `http://127.0.0.1:${cfg.port}`;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Unique per RUN, not per call.
 *
 * The database survives between runs, so a fixed number collides with the
 * account the last run created and every assertion reads as "duplicate" —
 * §32 S19, a test asserting a precondition it never established.
 */
const RUN = String(Math.floor(Math.random() * 90000) + 10000);
const MOBILE = `9${RUN}0001`;
const AADHAAR = `777${RUN}0001`;
const PASSWORD = 'a-long-enough-phrase';

/** What the database says, which is the only thing that counts. */
const row = async (sql, params = []) => (await pgQuery(sql, params)).rows[0] ?? null;

/**
 * Fill a field by the label printed next to it, one character at a time.
 *
 * Scoped to `input`, and that is not a nicety. `getByLabel` matches anything
 * with that ACCESSIBLE NAME — and the verification gate is a
 * `role="dialog" aria-labelledby="…"` whose title is "Verify your mobile
 * number", so `getByLabel(/mobile number/i)` resolved to the DIALOG and the
 * pass died on "Element is not an <input>". A harness that reports its own
 * selector as the application's failure is worse than no harness.
 */
async function type(page, label, value) {
  const box = page.locator('input').and(page.getByLabel(label, { exact: false })).first();
  await box.click();
  await box.fill('');
  // `type` rather than `fill`: the country-code defect only appears when the
  // handler runs per keystroke, which is what a person produces and what
  // `fill` skips entirely.
  await box.type(value, { delay: 12 });
  return box;
}

async function main() {
  if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);

  children.push(startVite('user-panel', cfg.port));
  if (!await waitFor(`${BASE}/`, 'the user dev server')) { stopAll(); process.exit(1); }

  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 480, height: 940 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  /**
   * Which URL, not just "a resource".
   *
   * The console says "Failed to load resource: 404" and names nothing, so a
   * pass that reports only that is a pass nobody can act on. Every non-2xx is
   * recorded with its method and path, and the failure prints them.
   */
  const badResponses = [];
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.request().method()} ${r.url()} → ${r.status()}`);
  });

  try {
    await page.goto(cfg.entry(BASE), { waitUntil: 'domcontentloaded' });
    await settle(page, 12000);

    // ── Open the signup form ────────────────────────────────────────────
    const signUpEntry = page.getByRole('button', { name: /sign ?(in|up)|create account|log ?in/i }).first();
    if (await signUpEntry.count()) { await signUpEntry.click(); await settle(page, 6000); }
    const signupTab = page.getByRole('tab', { name: /sign up/i }).first();
    if (await signupTab.count()) { await signupTab.click(); await page.waitForTimeout(300); }

    const onForm = await page.getByLabel(/aadhaar number/i).count() > 0;
    record('the signup form is reachable from the app', onForm);
    if (!onForm) {
      // Say WHAT is on screen instead. A pass that reports "never reached the
      // form" and nothing else is a pass nobody can act on — which is the same
      // complaint this file makes about the product.
      const seen = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
      const buttons = await page.locator('button, a[href], [role="tab"]').evaluateAll(
        (els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 25));
      throw new Error(`never reached the signup form. On screen: "${seen}" | controls: ${JSON.stringify(buttons)}`);
    }

    // ── THE DEFECT, typed ───────────────────────────────────────────────
    const mobileBox = await type(page, /aadhaar-linked mobile/i, `+91 ${MOBILE}`);
    const landed = await mobileBox.inputValue();
    record('a mobile typed WITH +91 lands as the ten digits', landed === MOBILE,
      `typed "+91 ${MOBILE}" → "${landed}"`);

    await type(page, /aadhaar number/i, AADHAAR);
    await type(page, /^password$/i, PASSWORD);
    await type(page, /confirm password/i, PASSWORD);

    // ── A refusal, before the one that works ────────────────────────────
    // Typing a mismatched confirmation and reading what the screen says back:
    // the server names the field, and the screen must show that rather than
    // replacing it with a sentence of its own.
    const confirmBox = page.getByLabel(/confirm password/i).first();
    await confirmBox.fill('');
    await confirmBox.type('something-else', { delay: 8 });
    await page.getByRole('button', { name: /create account/i }).click();
    await page.waitForTimeout(1200);
    const refusal = await page.getByRole('alert').first().innerText().catch(() => '');
    record('a mismatched confirmation is refused BY NAME', /passwords do not match/i.test(refusal),
      refusal ? `said: "${refusal.slice(0, 70)}"` : 'the screen said NOTHING');
    record('nothing was written for the refused attempt',
      !(await row('SELECT 1 FROM users WHERE mobile = $1', [MOBILE])));

    // ── The real signup ─────────────────────────────────────────────────
    await confirmBox.fill('');
    await confirmBox.type(PASSWORD, { delay: 8 });
    await page.getByRole('button', { name: /create account/i }).click();
    await settle(page, 10000);

    const account = await row(
      `SELECT user_id, mobile, kyc_status, joining_number, telegram_bot_id, password_hash
         FROM users WHERE mobile = $1`, [MOBILE]);
    record('pressing Create account wrote the ACCOUNT', Boolean(account),
      account ? `${account.user_id} on ${account.mobile}` : 'no row');
    record('the mobile stored is the one they meant',
      account?.mobile === MOBILE, `stored ${account?.mobile}`);
    record('it is queued for KYC, not approved',
      account?.kyc_status === 'PENDING_APPROVAL', `kyc_status=${account?.kyc_status}`);
    record('it has a password hash the login path can read',
      typeof account?.password_hash === 'string' && account.password_hash.length > 20);
    // The two the referral queue depends on.
    record('NO joining number yet — the channel join claims it',
      !account?.joining_number, `joining_number=${account?.joining_number ?? 'null'}`);
    const identity = await row('SELECT 1 FROM telegram_identities WHERE user_id = $1', [account?.user_id]);
    record('NO Telegram identity yet — the contact share creates it', !identity);

    // ── The gate ────────────────────────────────────────────────────────
    await page.waitForTimeout(1500);
    const dialog = page.getByRole('dialog');
    const gateUp = await dialog.count() > 0;
    record('the verification gate BLOCKS the app straight after signup', gateUp);

    if (gateUp) {
      const gateText = (await dialog.first().innerText()).replace(/\s+/g, ' ');
      record('it names the step, not just "unverified"',
        /verify your mobile|join our telegram|not available yet/i.test(gateText),
        gateText.slice(0, 90));

      // It must not be dismissible — every path it guards is already refused
      // by the server, so a close button would hide the one instruction that
      // restores access.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      record('Escape does not dismiss it', await page.getByRole('dialog').count() > 0);
      // Scoped INSIDE the dialog. The page-wide count found one — the shell's
      // own banner dismiss, sitting UNDER a fixed overlay at z-index 9000 and
      // unreachable — and reported the gate as dismissible. That is a gate
      // measuring the wrong region (§32 S21's cousin): the question is what is
      // inside the blocking surface, not what exists on the page.
      const closers = await dialog.first()
        .getByRole('button', { name: /close|dismiss|not now|later|skip/i }).count();
      record('it offers no way to close', closers === 0, `${closers} closing control(s) inside it`);
    }

    // ── The TELEGRAM half, driven through the real webhook ──────────────
    // The gate is on screen and blocking. Everything below happens in the
    // other app — so it arrives here as webhook deliveries, exactly as
    // Telegram would send them, authenticated by the bot's own secret. What is
    // asserted is that the SCREEN moves: the gate is a poll, and a gate that
    // does not notice is a player who sits there having done everything right.
    const bot = await row(
      `SELECT b.bot_id, b.webhook_secret, b.username
         FROM telegram_bots b JOIN users u ON u.telegram_bot_id = b.bot_id
        WHERE u.mobile = $1`, [MOBILE]);
    record('the account was assigned one of the live sign-in bots', Boolean(bot),
      bot ? `@${bot.username}` : 'no bot assigned');

    if (bot && gateUp) {
      // The screen must be pointing at THAT bot, not a generic one — with a
      // fleet, a generic link sends most players to a chat that cannot answer.
      const botLink = await dialog.first().getByRole('link').first().getAttribute('href').catch(() => '');
      record('the gate links to the bot this account was actually assigned',
        String(botLink).includes(bot.username), `href=${botLink}`);

      const deliver = (body) => fetch(`${API}/api/telegram/webhook/${bot.bot_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': bot.webhook_secret },
        body: JSON.stringify(body),
      }).then((r) => r.status);

      const tgId = 900000 + Number(RUN);
      record('a FORGED delivery is refused', await fetch(`${API}/api/telegram/webhook/${bot.bot_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'not-the-secret' },
        body: '{}',
      }).then((r) => r.status) === 401);

      // 1. The contact share.
      await deliver({ message: {
        chat: { id: tgId }, from: { id: tgId, first_name: 'Journey' },
        contact: { phone_number: `+91${MOBILE}`, user_id: tgId },
      } });
      await page.waitForTimeout(800);
      const linked = await row(
        'SELECT phone, contact_active FROM telegram_identities WHERE telegram_user_id = $1', [String(tgId)]);
      record('sharing the contact LINKS it to the form account',
        linked?.phone === MOBILE && linked?.contact_active === true, JSON.stringify(linked));

      // The gate polls every 30s; press its own button rather than waiting.
      await dialog.first().getByRole('button', { name: /check again/i }).click();
      await page.waitForTimeout(3000);
      const nowSays = (await page.getByRole('dialog').first().innerText()).replace(/\s+/g, ' ');
      record('the gate MOVES to the channel step once the number is proved',
        /join our telegram channel/i.test(nowSays), nowSays.slice(0, 80));

      // 2. The channel join.
      const channelId = (await row('SELECT channel_id FROM telegram_configs WHERE active'))?.channel_id;
      await deliver({ chat_member: {
        chat: { id: channelId },
        new_chat_member: { user: { id: tgId }, status: 'member' },
      } });
      await page.waitForTimeout(800);

      const done = await row(
        'SELECT joining_number FROM users WHERE mobile = $1', [MOBILE]);
      record('joining the channel CLAIMS the joining number', Boolean(done?.joining_number),
        `joining_number=${done?.joining_number ?? 'null'}`);

      await page.getByRole('dialog').first().getByRole('button', { name: /check again/i }).click();
      await page.waitForTimeout(3000);
      record('the gate LETS THEM IN once both halves hold',
        await page.getByRole('dialog').count() === 0,
        await page.getByRole('dialog').count() ? (await page.getByRole('dialog').first().innerText()).replace(/\s+/g, ' ').slice(0, 80) : '');

      // 3. And leaving closes it again — no sweep, no timer.
      await deliver({ chat_member: {
        chat: { id: channelId },
        new_chat_member: { user: { id: tgId }, status: 'left' },
      } });
      // The poll is 30s; this is the one place the pass waits for it, because
      // waiting IS the behaviour being asserted — nothing on this screen tells
      // the panel that somebody left in another app.
      await page.waitForTimeout(32000);
      record('LEAVING the channel closes the gate again, with no action here',
        await page.getByRole('dialog').count() > 0);

      // Put them back, so the login half below is not gated by this test's
      // own leftover state.
      await deliver({ chat_member: {
        chat: { id: channelId },
        new_chat_member: { user: { id: tgId }, status: 'member' },
      } });
      await page.waitForTimeout(800);
    }

    // ── Sign out, then sign back IN with the password ───────────────────
    // The COOKIE as well as the stored token. The session is an httpOnly
    // cookie and `authenticate` accepts it, so clearing localStorage alone
    // signs nobody out — the page reloads, `/me` answers from the cookie, and
    // the "login form" the pass then thinks it is filling in is the gate. That
    // is correct product behaviour and a harness that did not know it was
    // measuring nothing.
    await ctx.clearCookies();
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* private */ } });
    // RELOAD, not `goto`. The panel is a HashRouter and the entry URL is
    // `.../#/` — which is where we already are, so `goto` to it is a
    // SAME-DOCUMENT hash navigation and does not reload anything. React state
    // survived it, the signed-out player was still seated in the UI, and the
    // pass reported the login form as unreachable. The server had already
    // answered 401; only the page had not been told.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, 10000);

    // Prove the sign-out actually happened before asserting anything about the
    // login form. A pass that types into a screen belonging to a still-seated
    // player is measuring nothing, and it reports that as the form's fault.
    const after = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/v1/auth/me`, { credentials: 'include' });
      return { status: r.status, token: (() => { try { return localStorage.getItem('auth_token'); } catch { return 'unreadable'; } })() };
    }, API);
    record('clearing the cookie and the store actually signs them out',
      after.status === 401 && !after.token, `/me answered ${after.status}, token=${after.token ?? 'null'}`);

    const loginEntry = page.getByRole('button', { name: /sign ?(in|up)|create account|log ?in/i }).first();
    if (await loginEntry.count()) { await loginEntry.click(); await settle(page, 6000); }
    const loginTab = page.getByRole('tab', { name: /log in/i }).first();
    if (await loginTab.count()) { await loginTab.click(); await page.waitForTimeout(300); }

    // Asserted on the SAME locator the typing uses, so "reachable" and
    // "fillable" cannot disagree — the first version checked `getByLabel`
    // (which matches anything with that accessible name) and then typed into
    // `input`-scoped, so it reported the form reachable and timed out filling
    // it. A pass whose two halves ask different questions reports the gap
    // between them as the product's fault.
    const loginBox = page.locator('input').and(page.getByLabel(/mobile number/i)).first();
    const onLogin = await loginBox.count() > 0;
    record('the login form is reachable', onLogin,
      onLogin ? '' : `on screen: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160)}`);

    if (onLogin) {
      await type(page, /mobile number/i, MOBILE);
      await type(page, /^password$/i, PASSWORD);
      await page.getByRole('button', { name: /^log in$/i }).click();
      await settle(page, 10000);

      const token = await page.evaluate(() => {
        try { return localStorage.getItem('auth_token'); } catch { return null; }
      });
      record('logging in with the password seats the player', Boolean(token && token.length > 40));
      // Verified now, so nothing should be blocking — which is the other
      // direction of the same assertion and the one a false "always blocks"
      // implementation would fail.
      await page.waitForTimeout(1500);
      record('a VERIFIED player is not gated after signing in',
        await page.getByRole('dialog').count() === 0);
    }

    // ── The password reset, opened as the bot's link opens it ───────────
    // The token lives in the FRAGMENT, so this is the one credential on the
    // platform that never reaches a server log — and the only way to check that
    // the screen behind it works is to open the URL the bot would have sent.
    if (bot) {
      const issued = await import('../../domains/identity/passwordReset.service.js')
        .then((m) => m.issueResetLink({
          userId: account.user_id, telegramUserId: String(900000 + Number(RUN)),
          baseUrl: BASE,
        }));
      record('the bot can issue a reset link for a verified account', issued.ok,
        issued.ok ? `expires in ${issued.minutes}m` : issued.reason);

      if (issued.ok) {
        record('the link carries its token in the FRAGMENT, never the query',
          issued.url.includes('/#/reset/') && !issued.url.includes('?'), issued.url.replace(/reset\/.*/, 'reset/<token>'));

        await page.goto(issued.url, { waitUntil: 'domcontentloaded' });
        await settle(page, 8000);

        const onReset = await page.locator('#bb-new-password').count() > 0;
        record('the link opens a screen that takes a new password', onReset);

        if (onReset) {
          // Too short: refused BY NAME, and the screen says the link is spent.
          await type(page, /^new password$/i, 'short');
          await type(page, /confirm new password/i, 'short');
          const weakBtn = page.getByRole('button', { name: /change password/i });
          record('it will not submit a password below the floor',
            await weakBtn.isDisabled());

          const NEWPW = 'a-second-long-phrase';
          await type(page, /^new password$/i, NEWPW);
          await type(page, /confirm new password/i, NEWPW);
          await weakBtn.click();
          await settle(page, 8000);

          // Scoped to the RESET PANEL, not the page. Read from `body` this
          // matched the home screen's own "Sign in to play" and reported a
          // pass while the reset screen was not even on screen — a gate
          // measuring the wrong region (§32 S21). The panel is identified by
          // its own heading.
          const panel = page.getByRole('heading', { name: /password changed|choose a new password/i });
          const heading = await panel.count() ? await panel.first().innerText() : '(no reset panel on screen)';
          const inPanel = await page.locator('body').innerText();
          record('setting it says so, and says they must now sign in',
            /password changed/i.test(heading) && /sign in/i.test(inPanel),
            `heading: "${heading}"`);

          // The two consequences, read from the DATABASE.
          const after = await row(
            'SELECT password_hash, sessions_valid_from FROM users WHERE user_id = $1', [account.user_id]);
          record('the stored hash actually changed',
            after?.password_hash !== account.password_hash);
          record('and every session issued before it is now dead',
            Boolean(after?.sessions_valid_from), `cutoff=${after?.sessions_valid_from ?? 'null'}`);

          // Single use: the same link again.
          //
          // `goto` to the SAME hash URL is a same-document navigation and does
          // not reload — the component kept its "done" state and the password
          // field was never rendered, so the pass timed out looking for it and
          // reported the app's fault. Reload explicitly. (Same trap as the
          // sign-out above; it is this panel's router, not a one-off.)
          // The reset route is paced like every credential route — one
          // submission per ten seconds, and for a body with no mobile in it
          // that pace keys on the ADDRESS. So the second submit has to wait it
          // out, or what it measures is the pace rather than the token. (It
          // did: 429, and the assertion read that as "cannot be used twice"
          // for entirely the wrong reason.)
          await new Promise((r) => setTimeout(r, 11000));
          await page.goto(issued.url, { waitUntil: 'domcontentloaded' });
          await page.reload({ waitUntil: 'domcontentloaded' });
          await settle(page, 6000);
          record('the link still opens the reset screen when signed OUT',
            await page.locator('#bb-new-password').count() > 0,
            `on ${page.url().replace(/reset\/.*/, 'reset/<token>')}`);
          await type(page, /^new password$/i, 'a-third-long-phrase-x');
          await type(page, /confirm new password/i, 'a-third-long-phrase-x');
          await page.getByRole('button', { name: /change password/i }).click();
          await settle(page, 6000);
          const reused = await page.locator('body').innerText();
          record('the same link cannot be used twice',
            /no longer valid/i.test(reused), reused.replace(/\s+/g, ' ').slice(0, 90));
        }
      }
    }

    // ── The console, which is where a CORS block shows and nowhere else ──
    // `ERR_CERT_AUTHORITY_INVALID` is excluded: this sandbox routes outbound
    // HTTPS through a TLS-intercepting proxy, so a font or CDN fetch fails on
    // the certificate here and nowhere a player would be. Excluded by NAME
    // rather than by widening the filter, so a genuine cert problem in the
    // platform's own origins would still have to be looked at deliberately.
    const real = consoleErrors.filter((t) =>
      !/favicon|React DevTools|\[vite\]|ERR_CERT_AUTHORITY_INVALID/i.test(t));
    /**
     * The refusals this pass CAUSED, named one at a time.
     *
     * Three things were failing here and none was a defect: the 400 from the
     * deliberately mismatched confirmation, the 401 from the sign-out probe,
     * and a Google Fonts request the sandbox's TLS-intercepting proxy refuses.
     * An assertion that counts all three is an assertion that will be silenced
     * rather than read — so each exclusion is stated with its reason, and
     * anything else from the platform's OWN origin still fails.
     */
    const expected = [
      // This pass submits a mismatched confirmation on purpose, and asserts the
      // sentence that comes back.
      (u) => /POST .*\/auth\/register → 400$/.test(u),
      // And probes /me after clearing the session, to prove the sign-out.
      (u) => /GET .*\/auth\/me → 401$/.test(u),
      // The reset link is submitted TWICE on purpose, and the second time is
      // asserted to be refused — that is the single-use property.
      (u) => /POST .*\/auth\/password\/reset → 400$/.test(u),
    ];
    const ours = badResponses.filter((u) => u.includes('127.0.0.1') || u.includes(API));
    const unexpected = ours.filter((u) => !expected.some((fn) => fn(u)) && !/favicon|\.map/i.test(u));
    record('no request to OUR OWN origin was refused unexpectedly', unexpected.length === 0,
      unexpected.slice(0, 5).join(' ; '));

    // "Failed to load resource" is the console's echo of the responses above
    // and is covered precisely by that assertion; what this one is for is a
    // THROWN error in the panel's own code, which nothing else would surface.
    const thrown = real.filter((t) => !/Failed to load resource/i.test(t));
    record('the panel threw nothing during the whole journey', thrown.length === 0,
      thrown[0]?.slice(0, 140) ?? '');
  } catch (err) {
    record('the pass completed', false, err.message);
  } finally {
    // Leave nothing behind: this run created a real account on a shared
    // database, and the next run's assertions are about ITS rows (trap 10).
    await pgQuery('DELETE FROM users WHERE mobile = $1', [MOBILE]).catch(() => {});
    await browser.close().catch(() => {});
    stopAll();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main();

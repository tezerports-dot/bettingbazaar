// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Submit every form with nothing in it, and with numbers past its own bounds.
 *
 * ── Why pressing every control could not find this ─────────────────────────
 * `drive.js` presses each control once and asks whether anything happened. It
 * never SUBMITS a form, so it cannot see what one does with bad input — and
 * the refusal is where this platform's worst screens have hidden.
 *
 * `/users/balance-adjust` earned this file. Every control on it "worked": the
 * search returned rows, clicking a row highlighted it, the fields took text.
 * Press Apply Adjustment with all of it filled in and the platform said
 * **"All fields required"** — the panel read `u._id`, the server sends
 * `userId`, so the id was silently `undefined`. No credit or debit could ever
 * be made through that screen, and nothing failed loudly enough to notice.
 *
 * ── Three cases, and why only two run here ─────────────────────────────────
 *   EMPTY          submit with every field cleared
 *   OUT OF RANGE   push each number past its own declared min/max
 *   VALID          a real value, a real save
 *
 * The first two are safe on any screen: a form that refuses them writes
 * nothing. The third MUTATES, so it belongs to the mutating pass, against rows
 * that run creates — never against whatever the database happens to hold
 * (trap 10). This pass drives the first two and says so rather than implying
 * more coverage than it has (§29).
 *
 * ── What counts as a failure ───────────────────────────────────────────────
 *   1. A 5xx. A refusal is the CALLER's mistake and carries its own wording
 *      (§21); `serverError` answers a 500 with nothing, so an operator who
 *      typed 11 into a field capped at 10 is told the platform broke.
 *   2. An uncaught error.
 *   3. SILENCE — the form refused and said nothing, so the person presses the
 *      same button again. §14: a message has to be actionable.
 *
 * And one NOTE that is triage, not failure: a number field with no `min`/`max`
 * at all, where nothing on the client stops a typo.
 *
 *   npm run test:forms                              every panel
 *   npm run test:forms -- admin-panel               one panel
 *   npm run test:forms -- admin-panel /settings     one screen
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { panelScreens } from './routes.js';
import { PAGE_SCRIPT, collect, find, idOf } from './controls.js';
import { check, note, summary } from '../e2e/harness.js';
import {
  ROOT, API, EXECUTABLE, PANELS, stopAll, waitFor, startVite, navigate, settle,
  ignored, awaitBudget, seedActors, enableGameProviders,
} from './stack.js';

const SHOTS = join(ROOT, 'backend', 'tests', 'browser', 'screenshots', 'forms');
const REPORT = join(ROOT, 'backend', 'tests', 'browser', 'forms.report.json');

/** Leading emoji and punctuation stripped, so a decorated label still matches. */
const bare = (name) => String(name ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();

/**
 * The button that SAVES this form.
 *
 * Deliberately narrow. A pass that guesses wrong here does not report a bad
 * finding — it presses something destructive with an empty form, which is how
 * an earlier pass came within one `window.prompt` of releasing 36 disputed
 * deposits.
 */
const SUBMITS = /^(save|submit|apply|update|add|create|send|register|activate|ingest|fund|run|set|confirm|supply)\b/;

/**
 * Never pressed, even empty. Each one either destroys a row somebody else
 * owns, moves money, or ends the session for every screen after it.
 */
const NEVER = /^(delete|remove|release|refund|resolve|escalate|reject|decline|approve|block|unblock|suspend|logout|log out|sign out|restore|rollback|reset|clear|purge|deduct|credit|debit|withdraw)\b/;

const isField = (c) => c.kind === 'textarea'
  || (c.kind.startsWith('input:') && !/checkbox|radio|file|submit|button|image|hidden/.test(c.kind));
const isNumber = (c) => c.kind === 'input:number';

/**
 * A value that is definitely outside what this field says it accepts.
 *
 * Read from the field's OWN `min`/`max`, not invented: a number the field
 * never claimed to refuse proves nothing about its bounds, and a field that
 * declares none is reported rather than guessed at.
 */
function outOfRange(c) {
  if (c.max != null && c.max !== '') {
    const n = Number(c.max);
    if (Number.isFinite(n)) return { value: String(n + Math.max(1, Math.abs(n) * 0.5 + 1)), why: `above its max of ${c.max}` };
  }
  if (c.min != null && c.min !== '') {
    const n = Number(c.min);
    if (Number.isFinite(n)) return { value: String(n - Math.max(1, Math.abs(n) * 0.5 + 1)), why: `below its min of ${c.min}` };
  }
  return null;
}

/**
 * Everything the page SAYS right now.
 *
 * ── Why this is the whole body, not a list of selectors ────────────────────
 * The first version looked for `[role="status"]`, `[role="alert"]` and classes
 * containing "toast". `react-hot-toast` renders under generated class names
 * like `go2072408551`, so that selector list saw nothing — and the pass
 * reported `/revenue` "Fund Pool" as a form that refuses in silence when its
 * handler plainly does
 *
 *     if (!(amount > 0)) return toast.error('Enter a positive amount (₹)');
 *
 * A list of selectors is a guess about how a message is rendered; the text on
 * the page is the thing a person actually reads. So: take the body's words
 * before and after, and the refusal is whatever is there now that was not
 * there before. No library, no class name, no role required.
 */
const words = (page) => page.evaluate(
  () => (document.body.innerText || '').replace(/\s+/g, ' ').trim(),
).catch(() => '');

/** What appeared on screen that was not there a moment ago. */
const appeared = (before, after) => {
  if (!after || after === before) return '';
  const was = new Set(before.split(/(?<=[.!?])\s+|\s{2,}|\n/).map((x) => x.trim()));
  const now = after.split(/(?<=[.!?])\s+|\s{2,}|\n/).map((x) => x.trim()).filter(Boolean);
  const fresh = now.filter((x) => x && !was.has(x));
  return fresh.join(' | ').slice(0, 300);
};

/**
 * Submit one form and report what the platform said back.
 *
 * The three failures are watched on the WIRE and in the page, not in a toast:
 * a toast is what the screen says happened, and the whole point of this pass
 * is screens whose toast disagrees with reality.
 */
async function submitAndWatch(page, submit, label) {
  const errors = [], failed = [], statuses = [], methods = [];
  const onErr = (e) => errors.push(e.message);
  const onRes = (r) => {
    if (!/\/api\//.test(r.url()) || /\/api\/sse\//.test(r.url())) return;
    statuses.push(r.status());
    methods.push(r.request().method());
    if (r.status() >= 500 && !ignored(r.url())) {
      failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    }
  };
  page.on('pageerror', onErr);
  page.on('response', onRes);

  const before = await words(page);
  let pressed = true;
  try {
    await submit.click({ timeout: 4000 });
  } catch {
    pressed = false;   // disabled, covered, or gone — not a verdict about the form
  }
  await sleep(1400);
  const after = await words(page);
  page.off('pageerror', onErr);
  page.off('response', onRes);

  if (!pressed) return { verdict: 'NOT_PRESSED', why: 'the submit button could not be clicked' };
  if (errors.length) return { verdict: 'THREW', why: errors[0].slice(0, 180) };
  if (failed.length) {
    return {
      verdict: 'FIVE_HUNDRED',
      why: `${failed[0]} — a refusal is the caller's mistake and must carry its own wording (§21); `
        + `a 5xx is answered with nothing, so ${label} tells the operator the platform broke`,
    };
  }
  // A native form can refuse before any request goes out; that is a real
  // refusal and the browser shows it, so it counts as having spoken.
  const native = await page.evaluate(() => {
    const f = document.querySelector('main form');
    return f ? !f.checkValidity() : false;
  }).catch(() => false);
  const said = appeared(before, after);
  if (said) return { verdict: 'REFUSED', why: said.slice(0, 200) };
  if (native) return { verdict: 'REFUSED', why: 'the browser refused it on the field constraints' };
  if (statuses.length === 0) return { verdict: 'SILENT', why: 'nothing was said and no route was called' };
  /**
   * A filter that READS is allowed to accept an empty submit — `/reports`
   * "Run" and `/token-flow` "Apply" with no dates mean "everything", which is
   * the right answer. Only a write that swallowed an empty form is a finding,
   * so the verdict is taken from the METHOD rather than from the button's
   * wording.
   */
  const wrote = methods.some((m) => m !== 'GET' && m !== 'HEAD');
  if (!wrote) return { verdict: 'READ_ONLY', why: `it only read (${[...new Set(methods)].join(', ')}) — an empty filter means "everything"` };
  return { verdict: 'ACCEPTED', why: `the server answered ${[...new Set(statuses)].join(', ')} to a ${[...new Set(methods)].join('/')} with an empty form` };
}

// ── Run ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const onlyPanels  = args.filter((a) => a.endsWith('-panel'));
const onlyScreens = args.filter((a) => a.startsWith('/'));

if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);

const { actors, cached } = await seedActors();
mkdirSync(SHOTS, { recursive: true });

const report = { takenAt: new Date().toISOString(), forms: [] };
const tally = {};
const bump = (v) => { tally[v] = (tally[v] ?? 0) + 1; };

const restoreProviders = await enableGameProviders();
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'], headless: !process.env.BB_HEADED });

try {
  for (const { panel, screens } of panelScreens()) {
    if (onlyPanels.length && !onlyPanels.includes(panel)) continue;
    const cfg = PANELS[panel];
    const base = `http://127.0.0.1:${cfg.port}`;
    const { log } = startVite(panel, cfg.port);
    const probe = `${base}${panel === 'user-panel' ? '/' : `/${panel.split('-')[0]}/`}`;
    if (!await waitFor(probe, `${panel}'s dev server`)) {
      check('FORMS', panel, 'the dev server starts', 'listening', log.join('').slice(-300), false);
      continue;
    }

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(([k, v, ck, cv]) => {
      try { localStorage.setItem(k, v); if (ck) localStorage.setItem(ck, cv); } catch { /* blocked */ }
    }, [cfg.key, cfg.wrap(actors[panel]), cfg.cacheKey ?? '', cfg.cacheKey ? JSON.stringify(cached[panel]) : '']);
    await ctx.addInitScript(PAGE_SCRIPT);
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, 30000);

    for (const screen of screens) {
      if (onlyScreens.length && !onlyScreens.includes(screen)) continue;
      await awaitBudget(`${panel}${screen}`);
      await navigate(page, cfg, screen, base);
      await settle(page);

      const controls = await collect(page).catch(() => []);
      const fields = controls.filter(isField);
      /**
       * Disabled submits are KEPT, deliberately.
       *
       * The merchant panel's "Supply link" and "Price this amount" are greyed
       * out until their field holds something — which is the correct answer to
       * an empty form, and the first version of this pass dropped them and
       * reported the screen as having no form at all. A guard that works is a
       * result, not a gap.
       */
      const submits = controls.filter((c) => c.kind === 'button'
        && SUBMITS.test(bare(c.name)) && !NEVER.test(bare(c.name)));

      if (process.env.BB_FORMS_DEBUG) {
        console.log(`   ${panel}${screen}: ${controls.length} controls, ${fields.length} fields, `
          + `submit candidates: ${controls.filter((c) => c.kind === 'button').map((c) => bare(c.name)).slice(0, 8).join(' | ')}`);
      }
      if (!fields.length || !submits.length) continue;   // nothing to submit

      const results = [];
      // One submit per screen: the first save-shaped button. Pressing several
      // in sequence tests whatever the first one left behind, not the form.
      let target = submits[0];

      /**
       * ── "Add Balance" and "Create Merchant" OPEN a form; they do not save one
       * The first version of this pass pressed them, saw no request and no
       * message, and reported two working screens as forms that refuse in
       * silence. What actually happened is a dialog opened — which is the
       * screen doing exactly its job.
       *
       * So: press the candidate, and if the screen grew a form that was not
       * there before, the real submit is the one INSIDE it. That is also what
       * a person does — you cannot fill in a dialog you have not opened.
       */
      const openerFields = fields.length;
      {
        const probe = await find(page, target);
        if (probe && !(await probe.isDisabled().catch(() => false))) {
          await probe.click({ timeout: 4000 }).catch(() => {});
          await sleep(1200);
          const now = await collect(page).catch(() => []);
          const grew = now.filter(isField).length > openerFields;
          const inner = now.filter((c) => c.kind === 'button' && !c.disabled
            && SUBMITS.test(bare(c.name)) && !NEVER.test(bare(c.name))
            && idOf(panel, screen, c) !== idOf(panel, screen, target));
          if (grew && inner.length) {
            target = inner[inner.length - 1];   // the save at the end of the dialog
          } else {
            /**
             * Not an opener — which means that probe press just SUBMITTED the
             * form, and its toast is still on screen. The empty case then
             * compares "what appeared" against a page that already shows the
             * refusal, sees nothing new, and reports a working form as silent.
             * That is exactly what it did to `/revenue` Fund Pool, whose
             * handler plainly toasts "Enter a positive amount (₹)".
             *
             * So: put the screen back, and wait out the toast before asking
             * the question again. react-hot-toast clears at 4s by default.
             */
            await navigate(page, cfg, screen, base);
            await settle(page, 8000);
            await sleep(4500);
          }
        }
      }

      // ── EMPTY ────────────────────────────────────────────────────────────
      const liveFields = (await collect(page).catch(() => [])).filter(isField);
      for (const f of (liveFields.length ? liveFields : fields)) {
        const el = await find(page, f);
        if (el) await el.fill('').catch(() => {});
      }
      let el = await find(page, target);
      if (el) {
        // Re-read the button's state now the fields are empty: a submit that
        // has gone grey IS the refusal, and the clearest kind.
        const off = await el.isDisabled().catch(() => false);
        const r = off
          ? { verdict: 'GUARDED', why: 'the submit is disabled while the form is empty' }
          : await submitAndWatch(page, el, `${panel}${screen}`);
        bump(`EMPTY_${r.verdict}`);
        results.push({ case: 'EMPTY', control: idOf(panel, screen, target), ...r });
      }

      // ── OUT OF RANGE ─────────────────────────────────────────────────────
      await navigate(page, cfg, screen, base);
      await settle(page, 8000);
      // The EMPTY case's refusal is very likely still on screen, and this case
      // often produces the SAME sentence — so without waiting it out, "what
      // appeared" is nothing and a working form reads as silent.
      await sleep(4500);
      const numbers = (await collect(page).catch(() => [])).filter(isNumber);
      const bounded = numbers.map((n) => ({ n, out: outOfRange(n) })).filter((x) => x.out);
      const unbounded = numbers.filter((n) => !outOfRange(n));

      if (bounded.length) {
        for (const { n, out } of bounded) {
          const fe = await find(page, n);
          if (fe) await fe.fill(out.value).catch(() => {});
        }
        el = await find(page, target);
        if (el) {
          const off = await el.isDisabled().catch(() => false);
          const r = off
            ? { verdict: 'GUARDED', why: 'the submit is disabled while a value is out of range' }
            : await submitAndWatch(page, el, `${panel}${screen}`);
          bump(`RANGE_${r.verdict}`);
          results.push({
            case: 'OUT_OF_RANGE', control: idOf(panel, screen, target), ...r,
            pushed: bounded.map(({ n, out }) => `${n.name || '«unnamed»'} ${out.why}`).slice(0, 4),
          });
        }
      }

      report.forms.push({ panel, screen, at: report.takenAt, fields: fields.length, results });

      const broke = results.filter((r) => r.verdict === 'THREW' || r.verdict === 'FIVE_HUNDRED');
      const silent = results.filter((r) => r.verdict === 'SILENT');
      const shape = results.map((r) => `${r.case}→${r.verdict}`).join(', ') || 'nothing submitted';

      if (broke.length) {
        await page.screenshot({ path: join(SHOTS, `${panel}${screen.replace(/\//g, '_') || '_root'}.png`) }).catch(() => {});
        check('FORMS', panel, screen, 'a bad value is refused, not a 5xx',
          broke.map((b) => `${b.case}: ${b.why}`).join('  ||  '), false,
          `submitted with ${fields.length} field(s), as a person would`);
      } else if (silent.length) {
        check('FORMS', panel, screen, 'the refusal says something',
          `${silent.map((s) => s.case).join(', ')} — the form refused and told the person NOTHING, `
          + 'so they press the same button again (§14)', false,
          'watched the toasts, the inline errors and the wire');
      } else if (unbounded.length) {
        note('FORMS', panel, screen, 'every number field declares its bounds', shape,
          `${unbounded.length} number field(s) with no min/max: `
          + unbounded.map((n) => n.name || '«unnamed»').slice(0, 4).join(', ')
          + ' — nothing on the client stops a typo');
      } else {
        check('FORMS', panel, screen, 'empty and out-of-range are both refused', shape, true);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stopAll();
  await restoreProviders().catch((e) => console.error('could not restore game_providers:', e.message));
}

writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(`\n${'─'.repeat(78)}\nFORMS SUBMITTED\n`);
for (const [v, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${v}`);
}
console.log(`\nValid input is NOT driven here — that writes, and belongs to the mutating pass.`);
console.log(`Report: ${REPORT}`);

const { failed: failures } = summary();
process.exit(failures ? 1 : 0);

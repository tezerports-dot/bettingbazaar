// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every control a person can actually touch on a screen, and how to touch it.
 *
 * ── Why identity is a NAME and an ordinal, not a selector ───────────────────
 * A CSS path breaks the moment React re-renders, and clicking a control is the
 * thing that makes React re-render — so a path captured before a click is stale
 * by the time the next one is needed. What survives a re-render is what a
 * PERSON uses to find the control again: what it says. So a control is
 * identified by its ROLE, its accessible NAME, and its ordinal among controls
 * sharing that name, and it is re-found by that triple every time.
 *
 * ── The name is taken the way a screen reader takes it ─────────────────────
 * `aria-label`, then `title`, then a `<label for>`, then the trimmed text, then
 * `placeholder`, then `name`. A control that ends up with NO name is REPORTED
 * rather than skipped: an icon-only button with no accessible name is a defect
 * in its own right — a screen reader announces "button", nobody can address it,
 * and that is exactly how the admin Games panel's Delete button sat unusable
 * and untested until a browser opened the screen.
 *
 * ── Scope is the routed region ─────────────────────────────────────────────
 * The shell's navigation is the same links on all 44 admin screens. Counting
 * them per screen would put the denominator in the thousands and bury the real
 * work, so the shell is inventoried ONCE per panel and `<main>` per screen.
 *
 * ── One definition, installed in the page ──────────────────────────────────
 * Collecting and re-finding must agree about what a control IS, or the ordinal
 * means different things in the two halves and the pass clicks the wrong thing.
 * §5: the same logic written twice drifts. So there is ONE page-side module,
 * installed by `addInitScript`, and Node calls into it for both.
 */

/** Installed into every page. Everything below runs in the browser. */
export const PAGE_SCRIPT = `
window.__bb = (() => {
  const SEL = 'button, a[href], select, textarea, input, [role="button"]';

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'
      && s.display !== 'none' && s.opacity !== '0';
  };

  const nameOf = (el) => {
    const labelled = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    const raw = el.getAttribute('aria-label')
      || el.getAttribute('title')
      || (labelled && labelled.innerText)
      || (isField
            ? (el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '')
            : el.innerText)
      || '';
    return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 80);
  };

  const kindOf = (el) => {
    switch (el.tagName) {
      case 'BUTTON':   return 'button';
      case 'A':        return 'link';
      case 'SELECT':   return 'select';
      case 'TEXTAREA': return 'textarea';
      case 'INPUT':    return 'input:' + (el.getAttribute('type') || 'text');
      default:         return 'role-button';
    }
  };

  /** The routed region, or the whole page on a screen that renders no shell. */
  const region = () => document.querySelector('main') || document.body;

  /** Controls in document order, each with the triple that re-finds it. */
  const describe = (els) => {
    const seen = new Map();
    return els.map((el) => {
      const kind = kindOf(el), name = nameOf(el);
      const key = kind + '\\u0000' + name;
      const ordinal = seen.get(key) || 0;
      seen.set(key, ordinal + 1);
      return {
        kind, name, ordinal,
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        // Whether this control is ALREADY the chosen one. A segmented control's
        // selected segment, pressed again, correctly changes nothing — and the
        // pass was filing that as a dead button. Read from the control's own
        // ARIA state, which is the same fact a screen reader announces.
        on: el.getAttribute('aria-pressed') === 'true'
          || el.getAttribute('aria-selected') === 'true'
          || el.getAttribute('aria-current') === 'page',
        href: el.tagName === 'A' ? (el.getAttribute('href') || '') : '',
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value).slice(0, 40) : undefined,
        unnamed: name.length === 0,
      };
    });
  };

  const inRegion = () => [...region().querySelectorAll(SEL)].filter(visible);

  return {
    /** Every control inside the routed region, right now. */
    collect: () => describe(inRegion()),

    /** Every control in the persistent shell — inventoried once per panel. */
    shell: () => {
      const main = document.querySelector('main');
      if (!main) return [];
      const els = [...document.querySelectorAll(SEL)].filter((el) => !main.contains(el) && visible(el));
      return describe(els);
    },

    /**
     * The element for a triple, or null. Null is INFORMATION, not an error: a
     * control can be gone because the last click removed it, and the caller
     * wants to know that rather than catch an exception.
     */
    find: (spec) => {
      const els = inRegion();
      const desc = describe(els);
      let n = 0;
      for (let i = 0; i < els.length; i++) {
        if (desc[i].kind !== spec.kind || desc[i].name !== spec.name) continue;
        if (n === spec.ordinal) return els[i];
        n++;
      }
      return null;
    },

    /**
     * What is on screen now, for telling "it did something" from "it did not".
     *
     * ── Why it is not just the text ──────────────────────────────────────
     * The first version read innerText, which does NOT include what is in an
     * input. So typing "12" into a number field came back as INERT — the pass
     * accusing a working field of doing nothing, which is worse than missing a
     * defect, because somebody then goes and "fixes" what was never broken. The
     * same blindness hid every toggle: an ON/OFF switch that changes only a
     * class is invisible to text.
     *
     * (No backticks anywhere in this string. It is a template literal, and a
     * backtick in a comment inside one ends the literal — the trap CLAUDE.md
     * records against a SQL comment, met a second time here.)
     *
     * So it reads four independent things, and any one of them moving counts:
     * the text, the VALUES in the fields, the CHECKED and pressed states, and
     * the markup's own length — which catches a class flip that changes nothing
     * else. Cheap, and it fails in the safe direction: a false "it acted" is a
     * missed dead button, but a false "inert" sends somebody hunting a bug that
     * is not there.
     */
    fingerprint: () => {
      const r = region();
      const fields = [...r.querySelectorAll('input, select, textarea')];
      return {
        text: (r.innerText || '').trim().length,
        controls: inRegion().length,
        dialogs: document.querySelectorAll('[role="dialog"], .modal, [data-modal]').length,
        hash: location.hash,
        path: location.pathname,
        // What the fields HOLD — invisible to innerText, and the whole point of
        // typing into them.
        values: fields.map((f) => String(f.value ?? '')).join('\u0001').slice(0, 4000),
        checked: fields.map((f) => (f.checked ? '1' : '0')).join(''),
        pressed: [...r.querySelectorAll('[aria-pressed], [aria-selected], [aria-expanded], [data-state]')]
          .map((e) => (e.getAttribute('aria-pressed') ?? '') + (e.getAttribute('aria-selected') ?? '')
                    + (e.getAttribute('aria-expanded') ?? '') + (e.getAttribute('data-state') ?? '')).join(''),
        // A class flip — an active tab, a lit toggle — moves this and nothing
        // else. It is a HASH, not a length: the length CANCELS. Moving the
        // selected class from one tab to its neighbour makes one string longer
        // and the other shorter by exactly the same amount, so the total is
        // unchanged and four working leaderboard tabs were reported as dead
        // buttons. A hash has no such symmetry.
        markup: (() => {
          const html = r.innerHTML || '';
          let h = 5381;
          for (let i = 0; i < html.length; i++) h = ((h * 33) ^ html.charCodeAt(i)) >>> 0;
          return h;
        })(),
        toast: [...document.querySelectorAll('[role="status"], [role="alert"]')]
          .map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 4).join(' | ').slice(0, 300),
      };
    },
  };
})();
`;

/** Node-side helpers, so callers never re-spell the bridge. */
export const collect     = (page) => page.evaluate('window.__bb.collect()');
export const shell       = (page) => page.evaluate('window.__bb.shell()');
export const fingerprint = (page) => page.evaluate('window.__bb.fingerprint()');
export const find        = (page, spec) =>
  page.evaluateHandle(
    (s) => window.__bb.find(s),
    { kind: spec.kind, name: spec.name, ordinal: spec.ordinal },
  ).then((h) => h.asElement());

/** A control's stable id, for the manifest and for reporting. */
export const idOf = (panel, screen, c) =>
  `${panel}${screen}#${c.kind}:${c.name || '«unnamed»'}${c.ordinal ? `[${c.ordinal}]` : ''}`;

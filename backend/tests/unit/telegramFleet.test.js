// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The bot fleet's invariants, and the message templates' safety net.
 *
 * ── What is worth testing here ──────────────────────────────────────────────
 * Not "can a bot be registered" — that is one call to Telegram and a save. The
 * things that can silently ruin a platform are narrower:
 *
 *   1. Two live bots in one singular role. Inbound updates are authenticated by
 *      comparing a secret against "the live bot's" secret, so a second live
 *      sign-in bot means updates from the genuine one are rejected at random,
 *      depending on which row a non-deterministic read returned. The schema
 *      makes this impossible via a derived field plus a sparse unique index —
 *      and that derivation must actually run.
 *
 *   2. A template that Telegram refuses. It is a fire-and-forget send with
 *      nobody watching the result, so an admin's stray `<div>` would take
 *      signup offline in silence. The validator must catch what Telegram
 *      catches.
 *
 *   3. A player's own Telegram name rendered as markup. Names are chosen by the
 *      person and substituted into HTML we send as the platform.
 */
import { describe, it, expect } from 'vitest';
import {
  validateTemplate, render, escapeHtml, DEFAULT_TEMPLATES, TEMPLATE_KEYS, TEMPLATE_VARIABLES,
} from '../../domains/telegram/telegramTemplates.service.js';
import { webhookPathForRole } from '../../domains/telegram/telegramBots.service.js';

/**
 * The "at most one live bot per singular role" invariant is NOT tested here any
 * more. It is a GENERATED column plus a partial unique index, so the only thing
 * that can demonstrate it is a real database refusing the second row — which
 * `database/tests/telegramPg.test.js` does, including the UPDATE path that a
 * validation hook could never have seen.
 *
 * What stays here is what is genuinely pure: the webhook routing table and the
 * template validator and renderer.
 */

describe('only the roles that receive updates have a webhook', () => {
  it('routes sign-in and recovery to their own endpoints', () => {
    expect(webhookPathForRole('signin')).toBe('/api/telegram/webhook');
    expect(webhookPathForRole('recovery')).toBe('/api/telegram/recovery/webhook');
  });

  it('gives outbound-only roles no webhook at all', () => {
    // Registering one would point Telegram at an endpoint with no handler for
    // the conversation — an endpoint that can only drop what it receives.
    for (const role of ['broadcast', 'moderation', 'generic']) {
      expect(webhookPathForRole(role), role).toBeNull();
    }
  });
});

describe('a bad message cannot take signup offline', () => {
  it('accepts the markup Telegram supports', () => {
    expect(validateTemplate('<b>bold</b> <i>x</i> <a href="https://x.example">link</a>').ok).toBe(true);
  });

  it('refuses a tag Telegram does not support', () => {
    // Telegram answers "unsupported start tag" and sends nothing. Caught on
    // save, where the admin can see it, rather than in a player's silence.
    const res = validateTemplate('<div>hello</div>');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not support <div>/);
  });

  it('refuses an unclosed tag', () => {
    const res = validateTemplate('<b>hello');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/never closed/);
  });

  it('refuses tags closed out of order', () => {
    expect(validateTemplate('<b><i>x</b></i>').ok).toBe(false);
  });

  it('refuses an empty message', () => {
    // Blank means "restore the default" at the route; it must never be stored
    // as a message, because a stored blank would be sent as silence.
    for (const blank of ['', '   ', '\n', null, undefined, 42]) {
      expect(validateTemplate(blank).ok, JSON.stringify(blank)).toBe(false);
    }
  });

  it('refuses a message past what Telegram will accept', () => {
    expect(validateTemplate('x'.repeat(4001)).ok).toBe(false);
  });

  it('ships a default for every key the bot can send', () => {
    // The fallback is only as good as its coverage: a key with no default is a
    // key that can go silent.
    for (const key of TEMPLATE_KEYS) {
      expect(DEFAULT_TEMPLATES[key], key).toBeTruthy();
      expect(validateTemplate(DEFAULT_TEMPLATES[key]).ok, `default "${key}" must itself be valid`).toBe(true);
    }
  });

  it('declares every placeholder its default actually uses', () => {
    // A placeholder in the shipped copy that is not in the declared list would
    // be invisible in the panel, and an admin rewriting the message would drop
    // it without knowing it existed.
    for (const key of TEMPLATE_KEYS) {
      const used = [...DEFAULT_TEMPLATES[key].matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
      for (const name of used) {
        expect(TEMPLATE_VARIABLES[key] || [], `${key} uses {{${name}}}`).toContain(name);
      }
    }
  });
});

describe('a player-chosen name cannot become markup', () => {
  it('escapes a substituted value', () => {
    const out = render('Hello {{firstName}}', { firstName: '<a href="https://evil.example">click</a>' });
    expect(out).not.toContain('<a');
    expect(out).toContain('&lt;a');
  });

  it('escapes the quote that would break out of an attribute', () => {
    // The shipped login_link template puts a placeholder inside href="…".
    const out = render('<a href="{{loginUrl}}">go</a>', { loginUrl: '" onclick="x' });
    expect(out).not.toMatch(/href="" /);
    expect(out).toContain('&quot;');
  });

  it('escapes ampersands so a URL with query parameters still parses', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('does not escape the template itself', () => {
    // The template IS markup by design — escaping it would show players the
    // literal tags.
    expect(render('<b>{{x}}</b>', { x: 'hi' })).toBe('<b>hi</b>');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    // A visible {{typo}} in a chat is something somebody reports. A silently
    // empty gap reads as a finished sentence with a fact missing from it.
    expect(render('Join {{inviteLnik}} now', { inviteLink: 'x' })).toBe('Join {{inviteLnik}} now');
  });

  it('substitutes an empty string for a null value rather than printing "null"', () => {
    expect(render('Hi {{firstName}}', { firstName: null })).toBe('Hi ');
  });
});

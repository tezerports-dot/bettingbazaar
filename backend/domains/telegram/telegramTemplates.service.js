// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramTemplates.service.js — what the bot says.
 *
 * The first sentence a player ever reads from this platform comes from a bot,
 * and it is the sentence most likely to need changing after launch: it carries
 * the requirement that their Telegram account must be on the mobile number
 * linked to their Aadhaar. Getting that wording wrong does not show up as a bug
 * report, it shows up weeks later as a pile of failed verifications.
 *
 * So the copy is data, editable from the admin panel, with the shipped wording
 * as the fallback.
 *
 * ── Three rules that make this safe to hand to an operator ──────────────────
 *
 * 1. A missing or blank row means "use the default", never "send nothing".
 *    Silence after /start is indistinguishable from a broken platform.
 *
 * 2. Substituted values are HTML-escaped. These messages are sent with
 *    parse_mode HTML and one of the values is the player's own Telegram first
 *    name, which they choose. A name of `<a href="…">` would otherwise be
 *    rendered as markup by us, inside a message the platform appears to have
 *    written.
 *
 * 3. If Telegram refuses a custom template because its markup is malformed, the
 *    DEFAULT is sent instead. An admin's stray `<div>` must not be able to take
 *    signup offline — which is exactly what it would do, silently, since the
 *    failure is a 400 on a fire-and-forget send nobody is watching.
 */
import { db } from '#db';
import { callApi, activeConfig, liveBot } from './telegramClient.js';

/**
 * The shipped copy. Every key the bot can send must appear here — the fallback
 * is only as good as its coverage, and a key with no default is a key that can
 * go silent.
 */
export const DEFAULT_TEMPLATES = {
  // ── The conversation the bot now has ─────────────────────────────────────
  // It is SHORTER than the one it replaces, and that is the point: the account
  // already exists by the time anybody opens this chat, so the bot no longer
  // takes an Aadhaar number, no longer creates anything, and no longer hands
  // out a link that signs somebody in. It proves a phone number and gets them
  // into the channel. Two jobs, three messages.
  welcome:
    'Welcome to <b>Betting Bazaar</b>.\n\n'
    + 'Tap the <b>Share my contact</b> button below to verify your mobile number.\n\n'
    + '⚠️ It must be the number you signed up with — the mobile linked to your Aadhaar. '
    + 'If you are using a different Telegram account, sign in to that one first.',

  ask_contact:
    'Tap the <b>Share my contact</b> button below.\n\n'
    + 'Telegram sends us only the number on this account, and we check it against the '
    + 'one you signed up with.',

  // Sent when the number matched an account. The channel is the only thing left.
  contact_confirmed:
    '✅ Number confirmed.\n\n'
    + '<b>Last step:</b> join our official channel — {{inviteLink}}\n\n'
    + 'Your request is approved automatically. Once you are in, go back to the app.',

  // Both steps done. Deliberately carries NO link that signs anybody in: the
  // player already has a session from the form, and a bot that can mint one is
  // a bot whose compromise is an account takeover.
  verified:
    '🎉 You are all set.\n\nGo back to Betting Bazaar — everything is unlocked.',

  // The number is real and Telegram has verified it, but nobody signed up with
  // it. Naming the form is the whole value of this message: without it the
  // person has done everything they were asked and been told "no".
  not_registered:
    'That number is not registered on <b>Betting Bazaar</b>.\n\n'
    + 'Create your account on the app or website first — you will need your Aadhaar '
    + 'number and this mobile number — then come back here and share your contact.',

  // The ONE message on this platform that carries a credential. It says what
  // the link does and what it does NOT do, because somebody who expects to be
  // signed in and is asked for a password instead assumes the link is broken.
  password_reset:
    '🔑 <a href="{{resetUrl}}">Tap here to choose a new password</a>\n\n'
    + 'The link works once and expires in {{minutes}} minutes. It does not sign you in — '
    + 'you will pick a password and then log in with it.\n\n'
    + 'Did not ask for this? Ignore it. Nothing changes until somebody sets a password, '
    + 'and only this Telegram account can open the link.',

  recovery_welcome:
    '<b>Account recovery</b>\n\n'
    + 'Use this only if you have lost the Telegram account you signed up with, '
    + 'but still use the same mobile number.\n\n'
    + 'Send your <b>12-digit Aadhaar number</b> to begin.',
};

export const TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES);

/** Which placeholders each template may use — shown in the panel, and checked on save. */
export const TEMPLATE_VARIABLES = {
  welcome:           ['firstName', 'botUsername'],
  ask_contact:       ['firstName'],
  contact_confirmed: ['firstName', 'inviteLink', 'channelUsername'],
  verified:          ['firstName'],
  not_registered:    ['firstName'],
  password_reset:    ['resetUrl', 'minutes', 'firstName'],
  recovery_welcome:  ['firstName'],
};

/** Tags Telegram's HTML parse mode accepts. Anything else is a message it will refuse. */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'a', 'code', 'pre', 'span', 'tg-spoiler', 'blockquote',
]);

/**
 * Escape a value being substituted INTO markup. Never applied to the template
 * itself, which is markup by design.
 *
 * `"` is escaped along with the angle brackets because a template may put a
 * placeholder inside an attribute — `<a href="{{loginUrl}}">` is one of the
 * shipped defaults. Today that URL is generated by us and contains no quote,
 * but an admin is free to write `href="{{firstName}}"`, and then a quote in a
 * player-chosen name would break out of the attribute. Escaping here costs one
 * character and removes the whole class.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Check a template an admin typed, before it can take signup offline.
 *
 * Not a full HTML parser and not trying to be — it catches the two mistakes
 * that actually happen: a tag Telegram does not support, and a tag left
 * unclosed. Both make Telegram reject the whole message.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateTemplate(body) {
  if (typeof body !== 'string' || !body.trim()) {
    return { ok: false, error: 'The message cannot be empty.' };
  }
  // Telegram refuses messages over 4096 characters outright.
  if (body.length > 4000) {
    return { ok: false, error: `Too long: ${body.length} characters, limit is 4000.` };
  }

  const stack = [];
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g;
  let match;
  while ((match = tagPattern.exec(body)) !== null) {
    const [, closing, rawName] = match;
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) {
      return { ok: false, error: `Telegram does not support <${name}>. Allowed: ${[...ALLOWED_TAGS].join(', ')}.` };
    }
    if (closing) {
      if (stack.pop() !== name) return { ok: false, error: `</${name}> does not close the tag before it.` };
    } else {
      stack.push(name);
    }
  }
  if (stack.length) return { ok: false, error: `<${stack[stack.length - 1]}> is never closed.` };

  return { ok: true };
}

/**
 * Fill placeholders, escaping every value.
 *
 * An unknown placeholder is left as-is rather than blanked: `{{inviteLnik}}`
 * arriving in a player's chat is a visible typo somebody will report, whereas a
 * silently empty gap reads as a finished sentence with a fact missing from it.
 */
export function render(template, vars = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? escapeHtml(vars[name]) : whole
  ));
}

/** The admin's copy for a key, or the shipped default. */
export async function bodyFor(key) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEMPLATES, key)) {
    throw Object.assign(new Error(`Unknown template "${key}"`), { status: 400 });
  }
  const overrides = await db.telegram.getTemplates();
  const custom = overrides[key]?.trim();
  return { body: custom || DEFAULT_TEMPLATES[key], custom: Boolean(custom) };
}

/**
 * Send a template.
 *
 * @param {object} args
 * @param {string|number} args.chatId
 * @param {string} args.key           one of TEMPLATE_KEYS
 * @param {object} [args.vars]        placeholder values; escaped on substitution
 * @param {object} [args.extra]       passed to sendMessage (reply_markup, etc.)
 * @param {string} [args.role]        which bot sends it; 'signin' by default
 */
/**
 * @param {object} args
 * @param {{token: string}} [args.bot] send from THIS bot rather than resolving
 *   one. The sign-in fleet passes it, always: a player is in a chat with the
 *   ONE bot they were assigned, and Telegram refuses a message from any other
 *   with "bot can't initiate conversation with a user" — which reads to the
 *   player as a conversation that simply stopped. `role` remains the fallback
 *   for the singular-bot paths (recovery).
 */
export async function sendTemplate({ chatId, key, vars = {}, extra = {}, role = 'signin', bot: from = null }) {
  const { body, custom } = await bodyFor(key);
  const bot = from?.token ? from : await resolveSender(role);
  if (!bot?.token) return { ok: false, error: `no_live_${role}_bot` };

  const payload = (text) => ({
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  });

  const first = await callApi(bot.token, 'sendMessage', payload(render(body, vars)));
  if (first.ok || !custom) return first;

  // The custom copy was refused. If that is a markup problem, the default will
  // not have it — send that rather than leave the player with nothing. Loud,
  // because the admin's edit is now not being used and somebody must fix it.
  if (/can't parse entities|unsupported start tag|unclosed/i.test(first.error || '')) {
    console.error(`[telegram] template "${key}" was rejected by Telegram (${first.error}) — sent the default instead. Fix it in the admin panel.`);
    return callApi(bot.token, 'sendMessage', payload(render(DEFAULT_TEMPLATES[key], vars)));
  }
  return first;
}

/**
 * Which bot sends. The recovery conversation runs on its own bot for the same
 * reason it has its own token: a compromised primary must not be able to hand
 * out other people's accounts.
 */
async function resolveSender(role) {
  const registered = await liveBot(role);
  if (registered?.token) return registered;

  // Fall back to the credentials embedded in the active generation, so an
  // install that never registered a spare still sends.
  const cfg = await activeConfig();
  if (!cfg) return null;
  if (role === 'recovery') return cfg.recoveryBotToken ? { token: cfg.recoveryBotToken } : null;
  return cfg.botToken ? { token: cfg.botToken } : null;
}

/** Every key with its current body and whether it has been customised. */
export async function listTemplates() {
  const rows = await db.telegram.listTemplateRows();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return TEMPLATE_KEYS.map((key) => {
    const row = byKey.get(key);
    const custom = row?.body?.trim();
    return {
      key,
      body: custom || DEFAULT_TEMPLATES[key],
      default: DEFAULT_TEMPLATES[key],
      customised: Boolean(custom),
      variables: TEMPLATE_VARIABLES[key] || [],
      updatedAt: row?.updatedAt || null,
    };
  });
}

/** Save an admin's copy. Passing a blank body reverts the key to the default. */
export async function saveTemplate({ key, body, actorId }) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEMPLATES, key)) {
    throw Object.assign(new Error(`Unknown template "${key}"`), { status: 400 });
  }

  if (!String(body || '').trim()) {
    // Reverting means REMOVING the override, not storing a blank one: the
    // default lives in code, and a stored empty string would be a second way to
    // spell the same state that every read would then have to handle.
    await db.telegram.deleteTemplate(key);
    return { key, body: DEFAULT_TEMPLATES[key], customised: false };
  }

  const check = validateTemplate(body);
  if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });

  await db.telegram.setTemplate({ key, body, updatedBy: actorId });
  return { key, body, customised: true };
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/markets/boardRules.js — what players are told about the boards
 * before they bet (owner, 2026-10-08: "tell the players of all these").
 *
 * The pop-up on the board screen, the Rules page and the bet route's gate all
 * read the CURRENT text (`GET /api/v1/board-rules`), so what a player accepted
 * is what they were shown. Since 2026-10-14 the owner edits it in the admin
 * panel (Admin › Rules pop-up; "as we grow and add new rules or remove old
 * rules we need it editable"): each publish is a new row of
 * `board_rules_texts` (`database/repositories/boardRules.js`), a new version,
 * and every player is asked to accept again before their next bet. With no
 * row published, the text is `DEFAULT_BOARD_RULES` at
 * `BOARD_RULES_BASE_VERSION`.
 *
 * Two numbers the engine owns are never typed into the text, so it cannot
 * drift from them: an admin writes a token and it is filled in when served.
 *
 *   {winningsFeePercent}  SystemConfig.winningsFeePercent (computeWinningsPayout)
 *   {payoutMultiplier}    SystemConfig.payoutMultiplier (computeWinningsPayout)
 *   {backingSides}        one sentence, by riskRules.blockOppositeSideBetting
 *
 * The default describes the engine as built:
 *
 *   winner  = the side with less REAL money   cycleGenerator.completeCycle
 *   tie     = crypto random draw              cycleGenerator.completeCycle
 *   house   = phantom bets, display only      cycleGenerator.runPhantomEqualizer
 *   payout  = multiplier × stake − fee        riskValidation.computeWinningsPayout
 *   winners = real wins + curated entries     routes/winners.routes.js
 *   VIP / General boards apart                cycles.audience, bets.core.placeBet
 *   blind pools: total only, merge → result   cyclePublicView.poolsHidden
 *   staff may decide or cancel a round        admin/cycles.admin.routes.js manage-cycle
 */

/** The version of the built-in text; a published version is always above it. */
export const BOARD_RULES_BASE_VERSION = 4;

/** The tokens an admin may write, filled in when the text is served. */
export const BOARD_RULES_TOKENS = Object.freeze({
  winningsFeePercent: 'The winnings fee in force, as a number (e.g. 1).',
  payoutMultiplier: 'How many times the stake a win pays, as a number (e.g. 2).',
  backingSides: 'One sentence saying whether a player may back both sides of a round.',
});

/** Bounds on an admin's text, held again by the table's CHECKs. */
export const BOARD_RULES_LIMITS = Object.freeze({
  headingMax: 80, introMax: 400, sectionsMax: 30, titleMax: 80, bodyMax: 2000,
});

/** The built-in text, served until an admin publishes one. */
export const DEFAULT_BOARD_RULES = Object.freeze({
  heading: 'How the boards work',
  intro: 'Please read this before you bet. You can read it again any time on the Rules page.',
  sections: Object.freeze([
    {
      title: 'How a round is won',
      body: 'Each round, the side with LESS real player money staked on it wins. '
        + 'If both sides have exactly the same real money, the winner is picked by a secure random draw.',
    },
    {
      title: 'House bets in the pools',
      body: 'The pools you see on screen include bets placed by the house to make the two sides look balanced. '
        + 'House bets are never paid out and do not decide the winner, but because of them the pools on screen '
        + 'do not show which side has less real money. Once the pools merge, only the total of both sides is '
        + 'shown until the result.',
    },
    { title: 'Backing a side', body: '{backingSides}' },
    {
      title: 'Payout',
      body: 'A winning bet pays {payoutMultiplier}× its stake, minus a platform fee of {winningsFeePercent}% of that payout. '
        + 'A losing stake is not returned.',
    },
    {
      title: 'VIP and General boards',
      body: 'Players betting with their General (referral bonus) balance play on their own boards, separate from '
        + 'VIP ID players who bet with deposited money. The two never share a round or its pools. '
        + 'A General win is paid back into your General balance.',
    },
    {
      title: 'Exceptional situations',
      body: 'In exceptional situations, such as an attack or a technical fault, the platform may decide or '
        + 'cancel a round. A cancelled round returns every stake.',
    },
    {
      title: 'Winners list',
      body: 'The winners list can include example entries added by the platform. '
        + 'Those entries are not real players or real payouts.',
    },
  ]),
});

const backingSentence = (bothSides) => (bothSides
  ? 'You may back Delhi, Bombay or both in the same round. Each bet is settled on its own: '
    + 'only the bets on the winning side are paid.'
  : 'You may back only one side in a round: once you have a bet on Delhi or Bombay, '
    + 'a bet on the other side of that round is refused.');

/**
 * The text as players read it: tokens filled from the live config.
 * @param {{ version: number, heading: string, intro: string, sections: {title: string, body: string}[] }} text
 * @param {{ feePercent: number, multiplier: number, bothSides?: boolean }} live
 *   `SystemConfig.winningsFeePercent` and `payoutMultiplier`; `bothSides` is
 *   false only while `riskRules.blockOppositeSideBetting` is on.
 */
export function renderBoardRules(text, { feePercent, multiplier, bothSides = true }) {
  const fill = (str) => String(str)
    .replaceAll('{winningsFeePercent}', String(feePercent))
    .replaceAll('{payoutMultiplier}', String(multiplier))
    .replaceAll('{backingSides}', backingSentence(bothSides));
  return {
    version: text.version,
    heading: fill(text.heading),
    intro: fill(text.intro),
    sections: text.sections.map((sec) => ({ title: fill(sec.title), body: fill(sec.body) })),
  };
}

/**
 * An admin's draft, checked and trimmed; throws a 400 naming what is wrong.
 * An unknown `{token}` is refused, so a typo never reaches a player as braces.
 */
export function normaliseBoardRulesDraft(draft) {
  const L = BOARD_RULES_LIMITS;
  const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'BOARD_RULES_INVALID' });
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const heading = str(draft?.heading);
  const intro = str(draft?.intro);
  if (!heading || heading.length > L.headingMax) throw bad(`The heading must be 1 to ${L.headingMax} characters.`);
  if (intro.length > L.introMax) throw bad(`The intro must be at most ${L.introMax} characters.`);
  if (!Array.isArray(draft?.sections) || draft.sections.length < 1 || draft.sections.length > L.sectionsMax) {
    throw bad(`Keep between 1 and ${L.sectionsMax} rules.`);
  }
  const sections = draft.sections.map((sec, i) => {
    const title = str(sec?.title);
    const body = str(sec?.body);
    if (!title || title.length > L.titleMax) throw bad(`Rule ${i + 1}: the title must be 1 to ${L.titleMax} characters.`);
    if (!body || body.length > L.bodyMax) throw bad(`Rule ${i + 1}: the text must be 1 to ${L.bodyMax} characters.`);
    return { title, body };
  });
  for (const piece of [heading, intro, ...sections.flatMap((x) => [x.title, x.body])]) {
    for (const [, name] of piece.matchAll(/\{([^}]*)\}/g)) {
      if (!(name in BOARD_RULES_TOKENS)) throw bad(`Unknown placeholder {${name}}. Use one of: ${Object.keys(BOARD_RULES_TOKENS).map((t) => `{${t}}`).join(', ')}.`);
    }
  }
  return { heading, intro, sections };
}

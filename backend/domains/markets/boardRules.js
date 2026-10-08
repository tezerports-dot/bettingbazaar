// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/markets/boardRules.js — what players are told about the boards
 * before they bet (owner, 2026-10-08: "tell the players of all these").
 *
 * The ONE source of the board rules text. The pop-up on the board screen, the
 * Rules page and the bet route's gate all read it (`GET /api/v1/board-rules`),
 * so what a player accepted is what the engine does. Every statement here
 * describes code; change the code and this text in the same commit:
 *
 *   winner  = the side with less REAL money   cycleGenerator.completeCycle
 *   tie     = crypto random draw              cycleGenerator.completeCycle
 *   house   = phantom bets, display only      cycleGenerator.runPhantomEqualizer
 *   payout  = 2× stake − winningsFeePercent   riskValidation.computeWinningsPayout
 *   winners = real wins + curated entries     routes/winners.routes.js
 *   VIP / General boards apart                cycles.audience, bets.core.placeBet
 *   blind pools: total only, merge → result   cyclePublicView.poolsHidden
 *   staff may decide or cancel a round        admin/cycles.admin.routes.js manage-cycle
 *
 * BOARD_RULES_VERSION goes up whenever the text changes in substance; a player
 * who accepted an older version is asked again before their next bet.
 */

export const BOARD_RULES_VERSION = 3;

/**
 * @param {{ feePercent: number }} live  the winnings fee in force
 *   (`SystemConfig.winningsFeePercent`), so the text states the real number
 */
export function boardRules({ feePercent }) {
  return {
    version: BOARD_RULES_VERSION,
    sections: [
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
      {
        title: 'Payout',
        body: `A winning bet pays 2× its stake, minus a platform fee of ${feePercent}% of that payout. `
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
    ],
  };
}

// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/branding/palettes.js — the colour palettes a deployment can run.
 *
 * `Branding.palette` picks one (owner, 2026-10-15: "as admin I can switch
 * between golden and Stake-like colour palette with a switch"). The VALUES of
 * each palette are token declarations in each panel's own stylesheet, keyed by
 * `<html data-palette>` (§4: a literal colour only as a token's declaration;
 * §15: no panel imports another's source). This module owns only the names.
 *
 *   GOLD  — the brand's own colours: `primaryColor` / `secondaryColor` /
 *           `accentColor` drive every panel, as before.
 *   STAKE — a complete dark-navy and blue palette (backgrounds, cards, lines,
 *           text, buttons, accents). The three brand colours are not applied
 *           while it is on; they come back untouched when GOLD is chosen again.
 */
export const BRAND_PALETTES = Object.freeze(['GOLD', 'STAKE']);

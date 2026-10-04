// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The spellings of a mobile number people type, and the numbers that are not
 * one, shared by mobileInText (the JavaScript rule) and mobileInTextPg (the
 * database's `bb_text_has_a_mobile`), so the two are held to the same answers.
 */
export const MOBILE_SPELLINGS = Object.freeze([
  '9876543210',
  'call 9876543210 now',
  '+91 98765-43210',
  '0091 9876543210',
  '09876543210',
  '0919876543210',
  '98765  43210',
  '(987) 654-3210',
  '98765/43210',
  '98765_43210',
  '98765–43210',
  '98765\n43210',
  '98.765.432.10',
  '९८७६५४३२१०',
  '９８７６５４３２１０',
  'मेरा नंबर ९८७६५ ४३२१०',
  'raj9876543210',
  '9876​543210',
]);

export const NOT_MOBILES = Object.freeze([
  'UTR 412345678901',
  '5123456789',
  'order 50000',
  '9,000 + 5,000 + 1,000',
  '₹1,00,000 and ₹5,00,000',
  '98765 call 43210',
  '98765432101',
  'Team 9',
  '2026-10-04 09:12',
  '',
]);

// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/owaspFilter.js — WAF Integration (plan item 24). 2026-07-13.
 *
 * Scope EXACTLY as the plan locked it: OWASP-pattern attack blocking ONLY —
 * SQL-injection, XSS payloads, path traversal, null bytes — matched against
 * WHAT the request contains, never WHO sent it. No client IP / geography /
 * ISP input exists anywhere in this file, by design (see plan items 24/29-31
 * notes). Complements the existing layers: mongoSanitize (NoSQL operator
 * stripping), helmet CSP, and per-route rate limits; the SQLi signatures are
 * forward defense for the Postgres money layer.
 *
 * Gated by FLAGS.WAF_FILTER (default OFF — enable via env FEATURE_WAF_FILTER
 * =true or runtime flag override) so the owner opts in after watching logs:
 * signature filters can false-positive on legitimate text (chat, notes), so
 * the patterns below are deliberately conservative and each block is logged
 * with the matched rule for tuning.
 */
import { isEnabled, FLAGS } from '../services/featureFlags.service.js';

// Conservative signatures — precise enough that ordinary prose won't match.
const RULES = [
  { name: 'sqli-union-select',   re: /\bUNION\b[\s\S]{0,24}\bSELECT\b/i },
  { name: 'sqli-or-equals',      re: /['"]\s*(OR|AND)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i },
  { name: 'sqli-comment-drop',   re: /;\s*(DROP|ALTER|TRUNCATE)\s+(TABLE|DATABASE)\b/i },
  { name: 'sqli-schema-probe',   re: /\b(information_schema|pg_catalog|sysobjects)\b/i },
  { name: 'xss-script-tag',      re: /<script\b[^>]*>/i },
  { name: 'xss-event-handler',   re: /\bon(error|load|click|mouseover)\s*=\s*["']/i },
  { name: 'xss-js-uri',          re: /javascript:\s*[a-z(]/i },
  { name: 'path-traversal',      re: /(\.\.\/){2,}|(\.\.%2f){2,}/i },
  { name: 'null-byte',           re: /\x00|%00/ },
];

function scan(str) {
  for (const rule of RULES) if (rule.re.test(str)) return rule.name;
  return null;
}

export async function owaspFilter(req, res, next) {
  try {
    if (!(await isEnabled(FLAGS.WAF_FILTER))) return next();

    // One string per surface keeps the scan cheap (<1ms typical).
    const surfaces = [
      decodeURIComponent(req.originalUrl || '').slice(0, 4096),
      req.body && typeof req.body === 'object' ? JSON.stringify(req.body).slice(0, 65536) : String(req.body || ''),
    ];
    for (const s of surfaces) {
      const hit = s && scan(s);
      if (hit) {
        console.warn(JSON.stringify({
          level: 'warn', msg: 'waf_block', rule: hit,
          method: req.method, path: req.path, reqId: req.id,
        }));
        try {
          const { alertsSent } = await import('../services/metrics.service.js');
          alertsSent.inc({ key: `waf-${hit}` });
        } catch { /* metrics optional */ }
        return res.status(400).json({ success: false, message: 'Request blocked by security filter.' });
      }
    }
    next();
  } catch {
    next(); // the filter must never take the API down
  }
}

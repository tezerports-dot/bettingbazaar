// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Dependency validation (plan items 5 + 58, 2026-07-13) — the AUTOMATED
 * enforcement layer for the domain boundaries docs/governance/04-GOVERNANCE.md defines.
 * Run: npm run check:deps (wired into CI — violations fail the build).
 *
 * Rules are deliberately few and true: they pass the current codebase, so any
 * failure is NEW architectural drift, not noise. Pre-existing, documented
 * couplings (e.g. payment→merchant scoring, flagged in the file headers as
 * BBEPS §3.7 candidates) are grandfathered via specific allowances below —
 * tightening those is a deliberate migration, not a lint fix.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular imports make module init order fragile and boundaries meaningless. ' +
        'New cycles are architectural drift — break the cycle, do not extend it.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-core-must-not-import-routes',
      severity: 'error',
      comment:
        'Route files are the HTTP edge; domain services/models are the core. Core ' +
        'importing from backend/routes inverts the dependency direction (governance §1). ' +
        'Domain-OWNED *.routes.js files are edge adapters and may share route plumbing ' +
        'like routes/admin/_adminShared.js — that is by design, so they are excluded.',
      from: { path: '^backend/domains/', pathNot: '\\.routes\\.js$' },
      to: { path: '^backend/routes/' },
    },
    {
      name: 'wallet-authority-stays-pure',
      severity: 'error',
      comment:
        'The wallet authority is the single money mutator (governance §7). It must ' +
        'not depend on product domains (markets/casino/gameRegistry) — products call ' +
        'INTO it, never the reverse.',
      from: { path: '^backend/domains/wallet/' },
      to: { path: '^backend/domains/(markets|casino|gameRegistry)/' },
    },
    {
      name: 'no-orphaned-domain-modules',
      severity: 'info',
      comment: 'Unimported domain files are dead-artifact candidates (§13). Informational.',
      from: { orphan: true, path: '^backend/domains/' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^backend/',
    exclude: { path: '\\.(test|spec)\\.js$|^backend/tests/' },
    tsPreCompilationDeps: false,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};

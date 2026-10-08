// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// The backend lint: plain Node ESM JavaScript (backend/, database/, scripts/,
// loadtest/, tools/ and the root config files). Correctness rules only. The
// three panels lint themselves (`npm run lint` in each, own eslint.config.js).
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    'admin-panel/', 'merchant-panel/', 'user-panel/',
    'graphify-out/', 'design/', 'docs/', 'audit/', 'e2e/', 'coverage/',
  ]),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      // `catch {}` is a deliberate best-effort (a notice, a cleanup); any other empty block is still an error.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `const { a, ...rest } = row` is how a key is dropped; a leading underscore marks a binding kept on purpose.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true,
      }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // An interface's methods name their parameters to document the contract; the base class only throws.
    files: ['backend/providers/**/*.interface.js'],
    rules: { 'no-unused-vars': ['error', { args: 'none' }] },
  },
  {
    // Functions handed to page.evaluate() run in the browser, not in Node.
    files: ['backend/tests/browser/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // A k6 script: k6 supplies these.
    files: ['loadtest/bet-contention.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },
  // TEMPORARY, delete with the fix: these files were under another change when
  // the lint was set up, so their findings (unused imports and bindings, values
  // assigned and never read, a rethrow with no `cause`) are listed in that
  // commit instead of fixed here. Every other rule still applies to them.
  {
    files: [
      'backend/domains/identity/auth.middleware.js',
      'backend/routes/admin/branding.admin.routes.js',
      'backend/routes/admin/cycles.admin.routes.js',
      'backend/routes/admin/users.admin.routes.js',
      'backend/routes/upload.routes.js',
      'backend/startup/cronJobs.js',
      'backend/startup/socketHandlers.js',
      'backend/tests/browser/drive.js',
      'backend/tests/browser/mutate.js',
      'backend/tests/browser/run.js',
      'backend/tests/browser/stack.js',
      'backend/tests/e2e/scenarios/s1-buy.js',
      'backend/tests/e2e/scenarios/s7-cross-lifecycle.js',
      'backend/tests/e2e/scenarios/s8-pentest.js',
      'backend/tests/live/operations.mjs',
      'backend/tests/routes/adminUsersRoutes.test.js',
      'backend/tests/routes/securityMonitorRoutes.test.js',
      'backend/tests/routes/threeSeparateEntities.test.js',
      'backend/tests/unit/loadShed.test.js',
      'database/tests/betPg.test.js',
      'database/tests/casinoSettlementBonusPg.test.js',
      'database/tests/cycleGeneratorPg.test.js',
      'database/tests/ledgerPg.test.js',
      'database/tests/newDomains.test.js',
      'database/tests/withdrawalAdmissionPg.test.js',
      'database/tests/workflowEndToEndPg.test.js',
    ],
    rules: { 'no-unused-vars': 'off', 'no-useless-assignment': 'off', 'preserve-caught-error': 'off' },
  },
]);

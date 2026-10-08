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
]);

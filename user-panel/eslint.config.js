// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// The panel lint. The admin, merchant and user panels carry the same rule set
// (each panel owns its own copy, §15); change all three together.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'android']),
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser },
    rules: {
      // `catch {}` is a deliberate best-effort (logout, storage); any other empty block is still an error.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    rules: {
      // Type strictness, not a defect: hundreds of `any` at API boundaries; `tsc --strict` still runs.
      '@typescript-eslint/no-explicit-any': 'off',
      // A leading underscore marks a binding kept on purpose (a positional argument, a rest sibling).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true,
      }],
      // A missing dependency is a stale closure; with --max-warnings 0 a warning fails anyway.
      'react-hooks/exhaustive-deps': 'error',
      // React Compiler readiness, and these panels are not built by the compiler: these four flag
      // load-on-mount effects, latest-value refs, clock reads in a ticking render and memo
      // dependency spellings, all correct when React runs the components as written.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    files: ['*.config.{js,ts}', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/service-worker.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },
]);

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
    // This panel alone (it is the one inside the Android shell): every request
    // goes through services/secureTransport.ts, which sends it over encrypted
    // DNS in the app (CLAUDE.md §2, "How the player app reaches the network").
    // A direct call here would quietly use the phone's DNS instead.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/services/secureTransport.ts'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'Use secureFetch from services/secureTransport.' },
        { name: 'EventSource', message: 'Use openEventStream from services/secureTransport.' },
        { name: 'XMLHttpRequest', message: 'Use secureFetch from services/secureTransport.' },
        { name: 'WebSocket', message: 'The player app opens no socket (CLAUDE.md §12); requests go through services/secureTransport.' },
      ],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'fetch', message: 'Use secureFetch from services/secureTransport.' },
        { object: 'globalThis', property: 'fetch', message: 'Use secureFetch from services/secureTransport.' },
        { object: 'self', property: 'fetch', message: 'Use secureFetch from services/secureTransport.' },
        { object: 'window', property: 'EventSource', message: 'Use openEventStream from services/secureTransport.' },
        { object: 'navigator', property: 'sendBeacon', message: 'Use secureFetch from services/secureTransport.' },
      ],
    },
  },
  {
    // Screens never name an endpoint or touch the transport: every read and
    // write goes through the per-domain functions in services/api/ (CLAUDE.md
    // §2, "Which endpoint a player screen calls"), so retries, failover and the
    // last-good fallback are decided in one place, not per component.
    files: ['src/pages/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/redesign/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['**/services/apiClient', '**/services/secureTransport'],
          message: 'Call a function from services/api instead; add one there if none fits.' },
      ] }],
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

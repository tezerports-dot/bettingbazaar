// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import reactPlugin from 'eslint-plugin-react';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
        process: 'readonly',
      },
    },
    plugins: {
      react: reactPlugin,
      '@typescript-eslint': tsPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      'react/jsx-no-leaked-render': ['error', { validStrategies: ['ternary'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];

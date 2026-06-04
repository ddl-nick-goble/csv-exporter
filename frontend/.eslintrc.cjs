/**
 * Minimal ESLint config. React-recommended + hook rules, nothing opinionated
 * about formatting (Prettier handles that). The intent is "catch real bugs",
 * not enforce style.
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: { react: { version: 'detect' } },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  plugins: ['react', 'react-hooks'],
  rules: {
    'react/prop-types': 'off',                  // we don't use PropTypes here
    'react/react-in-jsx-scope': 'off',          // React 17+ JSX transform
    'react/no-unescaped-entities': 'off',       // copy text is curated, not user-supplied
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // Empty catches are how we intentionally swallow storage / parse errors;
    // each one is a documented "best-effort, fall back to empty" path.
    'no-empty': ['error', { allowEmptyCatch: true }],
    // `while (true)` is the standard pattern for the SSE / NDJSON reader loops.
    'no-constant-condition': ['error', { checkLoops: false }],
    // The CSV builder prepends a UTF-8 BOM (`﻿`) for Excel compatibility; the
    // tests assert against it as a literal. Don't flag it in strings.
    'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true }],
  },
  overrides: [{
    files: ['**/__tests__/**/*.{js,jsx}'],
    env: { node: true },
  }],
  ignorePatterns: ['dist/', 'node_modules/'],
};

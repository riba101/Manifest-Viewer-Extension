module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
  },
  extends: ['eslint:recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  globals: {
    chrome: 'readonly',
    module: 'readonly',
  },
  rules: {
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  ignorePatterns: ['dist/', 'node_modules/', 'screenshots-store/', 'Icon.psd'],
  overrides: [
    {
      files: ['__tests__/**/*.js'],
      env: {
        jest: true,
        node: true,
      },
    },
    {
      files: ['scripts/**/*.js'],
      env: {
        node: true,
      },
    },
    {
      files: ['app/background.js'],
      env: {
        serviceworker: true,
      },
    },
  ],
};

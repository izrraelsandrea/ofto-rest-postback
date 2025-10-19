module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true
  },
  extends: ['standard'],
  parserOptions: {
    ecmaVersion: 'latest'
  },
  rules: {
    'n/no-process-exit': 'off'
  },
  ignorePatterns: [
    'node_modules/',
    'coverage/'
  ]
};

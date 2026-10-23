import antfu from '@antfu/eslint-config'

export default antfu(
  {
    formatters: true,
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['info', 'warn', 'error', 'time', 'timeEnd'] }],
      'no-unused-vars': 'off',
      'unused-imports/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      'antfu/no-import-dist': 'warn',
      'pnpm/yaml-enforce-settings': 'off',
    },
  },
)

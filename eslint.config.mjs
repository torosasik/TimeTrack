import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default [
  { ignores: ['build_output', 'dist', 'node_modules', 'scripts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        ...globals.browser,
        ...globals.es2022,
        React: 'readonly',
        JSX: 'readonly',
        EventListener: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', {
        allowConstantExport: true,
        // shadcn/ui files export cva variant helpers and context hooks alongside components
        allowExportNames: ['badgeVariants', 'buttonVariants', 'toggleVariants', 'navigationMenuTriggerStyle', 'useSidebar'],
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: {
      // Tests mock global.Date with a class extending a saved constructor reference;
      // ESLint cannot statically prove the base is a constructor.
      'constructor-super': 'off',
      // Test mocks (Firestore snapshots, jest.fn chains) legitimately need `any`.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];

// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'ui', 'node_modules', 'eslint.config.mjs'],
  },

  // The published library and its tests. Type-checked, because these are the bugs users
  // would hit.
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'demo.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      eslintPluginPrettierRecommended,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // A property dropped by a rest destructuring is dropped on purpose.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },

  // The dashboard. `pnpm typecheck` covers its types, so here it is syntax and style only.
  {
    files: ['ui-src/**/*.{ts,vue}', 'ui-test/**/*.ts', 'vitest.config.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...pluginVue.configs['flat/recommended'],
      eslintPluginPrettierRecommended,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // Screens are one file each; a compound name would say nothing extra.
      'vue/multi-word-component-names': 'off',
    },
  },
);

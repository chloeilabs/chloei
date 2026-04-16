import path from "node:path"
import { fileURLToPath } from "node:url"

import js from "@eslint/js"
import pluginNext from "@next/eslint-plugin-next"
import eslintConfigPrettier from "eslint-config-prettier"
import jsxA11y from "eslint-plugin-jsx-a11y"
import pluginReact from "eslint-plugin-react"
import pluginReactHooks from "eslint-plugin-react-hooks"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import globals from "globals"
import tseslint from "typescript-eslint"

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url))
const sourceFiles = ["src/**/*.{ts,tsx}"]
const scriptFiles = ["auth.ts"]
const typeCheckedFiles = [...sourceFiles, ...scriptFiles]
const nodeConfigFiles = [
  "agent-worker.mjs",
  "src/lib/server/**/*.mjs",
  "tests/**/*.mjs",
  "eslint.config.js",
  "next.config.mjs",
  "postcss.config.mjs",
  "app-migrate.mjs",
]
const typeCheckedConfigs = [
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
].map((config) => ({
  ...config,
  files: typeCheckedFiles,
}))

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      "coverage/**",
      "next-env.d.ts",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    ...js.configs.recommended,
    files: nodeConfigFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...typeCheckedConfigs,
  eslintConfigPrettier,
  {
    files: sourceFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    plugins: {
      "@next/next": pluginNext,
      "jsx-a11y": jsxA11y,
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "simple-import-sort": simpleImportSort,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...pluginReact.configs.flat.recommended.rules,
      ...pluginNext.configs.recommended.rules,
      ...pluginNext.configs["core-web-vitals"].rules,
      ...pluginReactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "react/jsx-no-useless-fragment": "error",
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/self-closing-comp": "error",
      "simple-import-sort/exports": "error",
      "simple-import-sort/imports": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
  {
    files: scriptFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "no-console": "off",
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "simple-import-sort/exports": "error",
      "simple-import-sort/imports": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: false,
        },
      ],
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
  {
    files: sourceFiles,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message:
            "Use named exports by default. Default exports are only allowed in Next app entry files.",
        },
      ],
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/types/assets.d.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
]

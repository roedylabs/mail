// ESLint for the whole pnpm workspace (run: pnpm lint at the root).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, globalIgnores, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-eslint';

/** The checkout's local exclude file (`.git/info/exclude`, shared by all worktrees), if any. */
function localExcludes() {
  try {
    const path = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return [resolve(import.meta.dirname, path)];
  } catch {
    return [];
  }
}

// Everything Git ignores (build, stores, reports, local exclusions) – the flat
// config does not read the ignore files by itself.
const ignoreFiles = [resolve(import.meta.dirname, '.gitignore'), ...localExcludes()].filter((path) => existsSync(path));

export default defineConfig(
  ...ignoreFiles.map((path) => includeIgnoreFile(path)),
  globalIgnores(['crates/', 'apps/web/project.inlang/']),
  js.configs.recommended,
  ts.configs.recommendedTypeChecked,
  svelte.configs.recommended,
  prettier,
  svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
        // The same for all files, not only for .svelte: if the extensions
        // change between two files, the project service reloads all
        // TypeScript projects on every switch between .ts and .svelte,
        // which makes a full run many times slower.
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: ts.parser },
    },
  },
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.svelte'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // SvelteKit 3.1 reports the old option as deprecated in the dev server (`goto_replace_state_deprecated`).
          selector:
            "CallExpression:matches([callee.name='goto'], [callee.property.name='goto']) > ObjectExpression > Property:matches([key.name='replaceState'], [key.value='replaceState'])",
          message: 'Use goto(…, { replace: true }) instead of the deprecated option replaceState.',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [ts.configs.disableTypeChecked],
  },
);

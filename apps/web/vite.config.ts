import { paraglideVitePlugin } from '@inlang/paraglide-js';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { resolve } from 'node:path';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';
import { buildInfoDefines, resolveBuildInfo } from './vite/build-info.ts';
import { chunkGroups } from './vite/chunks.ts';
import { licenses } from './vite/licenses.ts';

const buildInfo = resolveBuildInfo();

// Rust licenses from `pnpm licenses:server`; relative paths start at the repo root.
const serverLicenses = process.env.ROEDY_SERVER_LICENSES
  ? resolve(import.meta.dirname, '../..', process.env.ROEDY_SERVER_LICENSES)
  : undefined;

// Backend for `pnpm dev` (cargo run -- serve); /api and the health checks go there.
const backend = process.env.ROEDY_DEV_BACKEND || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      // `prefs` sets the language from the settings via `overwriteGetLocale`;
      // the strategy only applies without it (tests without `prefs`). Same as in the `sync` script (package.json).
      strategy: ['baseLocale'],
    }),
    sveltekit({
      // SPA: one index.html for all routes, which the backend serves for unknown paths.
      adapter: adapter({ fallback: 'index.html' }),
      // Identifier for detecting new versions; from the build info instead of the clock so the build stays reproducible.
      version: { name: `${buildInfo.version}+${buildInfo.sha || buildInfo.date}` },
      // `#lib/app-worker.ts` registers the service worker (src/service-worker/) itself at start-up, outside development.
      serviceWorker: { register: false },
    }),
    licenses({
      generated: buildInfo.date,
      serverLicenses,
      include: ['@inlang/paraglide-js'],
    }),
  ],
  define: buildInfoDefines(buildInfo),
  environments: {
    client: {
      build: {
        // A few large chunks instead of about a hundred small ones, start-up order as without groups (`vite/chunks.ts`).
        rolldownOptions: { output: { codeSplitting: { groups: chunkGroups } } },
        // The "shell" chunk is large on purpose (about 630 kB raw); the warning limit lies above it,
        // `scripts/js-budget.mjs` checks the budget per route.
        chunkSizeWarningLimit: 1000,
      },
    },
  },
  server: {
    proxy: {
      '/api': backend,
      '/branding': backend,
      '/manifest.webmanifest': backend,
      '/healthz': backend,
      '/readyz': backend,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        plugins: [svelteTesting()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
          setupFiles: ['./vitest-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'build',
          environment: 'node',
          include: ['vite/**/*.test.ts'],
        },
      },
    ],
  },
});

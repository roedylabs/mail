// Load test with 50,000 emails: the same fixtures as the
// E2E suite (binary with embedded web app, fresh Stalwart v1), but only
// e2e/*.load.ts and with long time limits. Start only via
// `scripts/load-test.sh`; the measurements end up in test-results/load-test/.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({
  ...base,
  testMatch: '*.load.ts',
  // Seeding and indexing take minutes, each measuring step has its own limits.
  timeout: 30 * 60_000,
  use: { ...base.use, trace: 'off', screenshot: 'off' },
});

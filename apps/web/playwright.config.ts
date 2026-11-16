// E2E suite against the binary with the embedded web app and a real
// Stalwart v1. Start only via
// `scripts/e2e.sh` (locally and in e2e.yml): the script builds the web app and
// the binary and sets up Stalwart; the fixtures in e2e/fixtures.ts start a
// fresh instance per spec file.
import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;

// Traces, the HTML report (steps with the values of `fill`) and the page
// snapshot in error-context.md show the entered passwords and app passwords,
// screenshots show the setup token or the MFA secret with QR code depending on
// the step. In CI, failure reports end up as an artifact, so there only error
// messages and the backend log. Locally everything stays in
// test-results/ for debugging and is not shared.
if (ci) process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export default defineConfig({
  testDir: 'e2e',
  // One Stalwart for the whole run, and flows that build on each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    // A click on a missing element fails after 15 s instead of only with the test.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: ci ? 'off' : 'retain-on-failure',
    screenshot: ci ? 'off' : 'only-on-failure',
  },
});

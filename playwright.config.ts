import { defineConfig } from '@playwright/test';

// Browser tests for the Mini App. Build first: `npm run build && npm run test:e2e`.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    trace: 'off',
  },
  webServer: [
    { command: `${process.env.PYTHON || 'python3'} e2e/api_server.py`, url: 'http://127.0.0.1:8000/api/bootstrap',
      ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 30_000,
      // An unauthenticated bootstrap answers 401 once the API is up.
      stdout: 'ignore', stderr: 'pipe' },
    { command: 'npm run start', url: 'http://127.0.0.1:3000', reuseExistingServer: false, timeout: 60_000 },
  ],
});

import { defineConfig } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT ?? '3000';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 35_000,
  use: { baseURL: `http://localhost:${port}`, browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'], screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: `PORT=${port} npm run dev`, url: `http://localhost:${port}/healthz`, reuseExistingServer: true, timeout: 30_000 },
});

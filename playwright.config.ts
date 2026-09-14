import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './scripts/limpiar-capturas.js',
  fullyParallel: true,
  timeout: 45_000,
  retries: 1,              // una reintento: la web a veces tarda en hidratar
  workers: 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://formed.cl',
    headless: true,        // usa `npm run test:ver` para mirar el navegador
    screenshot: 'only-on-failure',
    launchOptions: {
      // LENTO=1 ralentiza cada acción para poder seguir el flujo con la vista.
      slowMo: process.env.LENTO ? 700 : 0,
    },
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

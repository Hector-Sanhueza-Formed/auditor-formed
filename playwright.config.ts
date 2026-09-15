import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';

// Carga .env sin dependencias: ahí vive RUT_PRUEBA, que no se versiona.
const contenidoEnv = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
for (const linea of contenidoEnv.split('\n')) {
  const limpia = linea.trim();
  if (!limpia || limpia.startsWith('#')) continue;
  const corte = limpia.indexOf('=');
  if (corte < 0) continue;
  const clave = limpia.slice(0, corte).trim();
  if (!process.env[clave]) process.env[clave] = limpia.slice(corte + 1).trim();
}

export default defineConfig({
  testDir: './tests',
  globalSetup: './scripts/limpiar-capturas.js',
  fullyParallel: true,
  timeout: 45_000,
  retries: 1,              // un reintento: la web a veces tarda en hidratar
  workers: 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://formed.cl',
    headless: true,        // usa `npm run ver:reserva` para mirar el navegador
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

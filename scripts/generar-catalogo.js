/**
 * Genera data/profesionales.json a partir de lo que publica hoy formed.cl.
 *
 * Es un SNAPSHOT (línea base), no una fuente de verdad independiente: sirve
 * para detectar cambios futuros —profesionales que desaparecen del listado o
 * que cambian de especialidad—, no para validar que lo publicado hoy sea
 * correcto. Regenéralo a propósito, revisando el diff en git.
 *
 * Uso: npm run catalogo
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const URL = 'https://formed.cl/profesionales';
const SALIDA = path.join(__dirname, '..', 'data', 'profesionales.json');

(async () => {
  const navegador = await chromium.launch();
  const page = await navegador.newPage();

  console.log(`Abriendo ${URL} …`);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('.pro-card', { timeout: 30_000 });

  const profesionales = await page.$$eval('.pro-card', (tarjetas) =>
    tarjetas
      .map((tarjeta) => ({
        nombre: (tarjeta.querySelector('.pro-nombre-real')?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim(),
        especialidad: (tarjeta.querySelector('.pro-cargo')?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim(),
      }))
      .filter((p) => p.nombre),
  );

  await navegador.close();

  if (profesionales.length === 0) {
    throw new Error('No se extrajo ningún profesional: ¿cambiaron los selectores del sitio?');
  }

  // Un mismo profesional puede aparecer en varias sucursales.
  const unicos = [...new Map(profesionales.map((p) => [p.nombre, p])).values()];
  unicos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  fs.writeFileSync(SALIDA, JSON.stringify(unicos, null, 2) + '\n');

  const duplicados = profesionales.length - unicos.length;
  console.log(`Tarjetas encontradas : ${profesionales.length}`);
  console.log(`Profesionales únicos : ${unicos.length}${duplicados ? ` (${duplicados} repetidos)` : ''}`);
  console.log(`Escrito en           : ${path.relative(process.cwd(), SALIDA)}`);

  const sinEspecialidad = unicos.filter((p) => !p.especialidad);
  if (sinEspecialidad.length) {
    console.log(`\n⚠  ${sinEspecialidad.length} sin especialidad publicada:`);
    sinEspecialidad.forEach((p) => console.log(`   - ${p.nombre}`));
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

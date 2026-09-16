/**
 * Recorre "Reserva por Profesional" y escribe data/agenda-profesional.json
 * con el mapa completo: cada sucursal, sus profesionales y las atenciones que
 * ofrece cada uno.
 *
 * Ese mapa es la entrada del módulo 4: los tests generan una comprobación por
 * combinación (sucursal × profesional × atención), y sin el mapa no se sabe
 * cuántas son.
 *
 * Nunca pasa del paso 3: aquí solo se inventaría, no se consulta disponibilidad.
 *
 * Los desplegables se enumeran y se seleccionan con los ayudantes de
 * flujo-profesional.js, que bajan por el menú virtualizado: elegir por posición
 * no sirve, porque el DOM solo contiene la ventana visible del listado.
 *
 * Uso: npm run agenda-profesional
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const F = require('./flujo-profesional.js');

const SALIDA = path.join(__dirname, '..', 'data', 'agenda-profesional.json');

/** Deja el wizard con una sucursal ya elegida, en el paso de profesionales. */
async function abrirEnSucursal(page, sucursal) {
  const marco = await F.abrirWizard(page);
  if (!(await F.elegirPorTexto(page, marco, sucursal))) {
    throw new Error(`la sucursal ya no aparece: ${sucursal}`);
  }
  await F.continuar(page, marco);
  await page.waitForTimeout(5_000);
  return marco;
}

(async () => {
  const navegador = await chromium.launch();
  const page = await navegador.newPage({ viewport: { width: 1440, height: 1200 } });

  console.log('Abriendo el flujo de reserva por profesional …');
  let marco = await F.abrirWizard(page);
  const sucursales = await F.opcionesVisibles(page, marco);
  await page.keyboard.press('Escape').catch(() => undefined);

  console.log(`Sucursales: ${sucursales.length}\n`);

  const mapa = [];
  let totalCombinaciones = 0;

  for (const sucursal of sucursales) {
    marco = await abrirEnSucursal(page, sucursal);

    const profesionales = await F.opcionesVisibles(page, marco);
    await page.keyboard.press('Escape').catch(() => undefined);
    console.log(`── ${sucursal} — ${profesionales.length} profesionales`);

    const fichas = [];
    for (const [indice, profesional] of profesionales.entries()) {
      let atenciones = [];
      try {
        if (await F.elegirPorTexto(page, marco, profesional)) {
          await F.continuar(page, marco);
          await page.waitForTimeout(4_000);

          atenciones = await F.opcionesVisibles(page, marco);
          await page.keyboard.press('Escape').catch(() => undefined);
          await F.volver(page, marco);
        } else {
          console.log(`   ⚠ no se pudo seleccionar: ${profesional.slice(0, 45)}`);
        }
      } catch (e) {
        console.log(`   ⚠ ${profesional.slice(0, 45)}: ${e.message.split('\n')[0].slice(0, 50)}`);
        // Estado inesperado: se rehace el camino hasta esta sucursal.
        marco = await abrirEnSucursal(page, sucursal);
      }

      fichas.push({ profesional, atenciones });
      totalCombinaciones += atenciones.length;
      console.log(
        `   [${String(indice + 1).padStart(2)}/${profesionales.length}] ` +
          `${profesional.slice(0, 50)} → ${atenciones.length} atención(es)`,
      );
    }

    mapa.push({ sucursal, profesionales: fichas });
    fs.writeFileSync(SALIDA, JSON.stringify(mapa, null, 2) + '\n'); // guardado parcial
  }

  await navegador.close();

  const sinAtenciones = mapa.flatMap((s) =>
    s.profesionales
      .filter((p) => p.atenciones.length === 0)
      .map((p) => `${s.sucursal} · ${p.profesional}`),
  );

  console.log('\n──────── RESUMEN ────────');
  console.log(`Sucursales                 : ${mapa.length}`);
  console.log(`Fichas sucursal×profesional: ${mapa.reduce((a, s) => a + s.profesionales.length, 0)}`);
  console.log(`Combinaciones a auditar    : ${totalCombinaciones}`);
  if (sinAtenciones.length) {
    console.log(`\n⚠ ${sinAtenciones.length} sin ninguna atención:`);
    sinAtenciones.forEach((s) => console.log(`   - ${s}`));
  }
  console.log(`\nEscrito: ${path.relative(process.cwd(), SALIDA)}`);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

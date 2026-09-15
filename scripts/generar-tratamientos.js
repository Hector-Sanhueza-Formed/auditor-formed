/**
 * Recorre los 34 tratamientos de "Reserva por Especialidad" y produce:
 *
 *   data/tratamientos.json  — cada tratamiento con los profesionales que
 *                             ofrece y cuántas horas tiene disponibles.
 *   data/profesionales.json — se le agrega a cada profesional el campo
 *                             `tratamientos`, con aquellos en los que aparece.
 *
 * Además informa los desajustes entre ambos mundos: profesionales que la
 * agenda ofrece pero no están en el catálogo, y viceversa.
 *
 * El flujo se detiene siempre en el paso 3 (día y hora). NUNCA reserva.
 *
 * Uso: npm run tratamientos
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const F = require('./flujo-especialidad.js');

const DIR_DATOS = path.join(__dirname, '..', 'data');
const SALIDA_TRATAMIENTOS = path.join(DIR_DATOS, 'tratamientos.json');
const CATALOGO = path.join(DIR_DATOS, 'profesionales.json');

/** Carga .env: ahí vive RUT_PRUEBA, que no se versiona. */
function cargarEnv() {
  const ruta = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(ruta)) return;
  for (const linea of fs.readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte < 0) continue;
    const clave = limpia.slice(0, corte).trim();
    if (!process.env[clave]) process.env[clave] = limpia.slice(corte + 1).trim();
  }
}

/**
 * La agenda muestra "Dra. María Julia Puca C (Dermatología-…)(De 10 a 100 años)".
 * Nos quedamos con el nombre: sin título ni paréntesis.
 */
function limpiarNombre(crudo) {
  return crudo
    .replace(/\([^)]*\)/g, '')
    .replace(/^\s*(Dra?\.|Ps\.|Mg\.|Klga?\.|Nut\.|T\.O\.|Mat\.)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  cargarEnv();
  F.rutDePrueba(); // falla temprano y con mensaje claro si falta el RUT

  const navegador = await chromium.launch();
  const page = await navegador.newPage({ viewport: { width: 1400, height: 1200 } });
  const capturadas = F.escucharDisponibilidad(page);

  console.log('Abriendo el flujo de reserva por especialidad …');
  const marco = await F.avanzarHastaTratamientos(page);

  const tratamientos = await F.listarTratamientos(page, marco, capturadas);
  console.log(`Tratamientos encontrados: ${tratamientos.length}\n`);

  const resultado = [];
  let marcoActual = marco;

  for (const [indice, tratamiento] of tratamientos.entries()) {
    // Si el wizard queda en un estado inesperado, se rehace el flujo desde
    // cero en vez de abortar la recolección entera.
    if (indice > 0) {
      try {
        await F.reiniciarParaOtroTratamiento(page, marcoActual);
      } catch {
        console.log('  ↻ reiniciando el flujo desde el principio');
        marcoActual = await F.avanzarHastaTratamientos(page);
      }
    }

    let profesionales = [];
    try {
      const disponibilidad = await F.abrirDisponibilidad(page, marcoActual, tratamiento, capturadas);
      profesionales = F.profesionalesDe(disponibilidad);
    } catch (e) {
      console.log(`  ⚠ ${tratamiento}: ${e.message.split('\n')[0].slice(0, 70)}`);
    }

    const horas = profesionales.reduce((suma, p) => suma + p.horas, 0);
    resultado.push({
      tratamiento,
      profesionales: profesionales.map((p) => ({
        nombre: limpiarNombre(p.nombre),
        nombreAgenda: p.nombre,
        sucursales: p.sucursales,
        horas: p.horas,
      })),
      totalProfesionales: profesionales.length,
      totalHoras: horas,
    });

    const marca = profesionales.length ? ' ' : '⚠';
    console.log(
      `${marca} [${String(indice + 1).padStart(2)}/${tratamientos.length}] ` +
        `${tratamiento} → ${profesionales.length} prof, ${horas} horas`,
    );
  }

  fs.writeFileSync(SALIDA_TRATAMIENTOS, JSON.stringify(resultado, null, 2) + '\n');
  await navegador.close();

  // El cruce con el catálogo vive en su propio módulo, que también se puede
  // reejecutar sin volver a navegar (npm run cruzar).
  const cruce = require('./cruzar-tratamientos.js');
  console.log('');
  cruce.informar(cruce.cruzar());
  console.log(`\nEscrito: ${path.relative(process.cwd(), SALIDA_TRATAMIENTOS)}`);
  console.log(`Actualizado: ${path.relative(process.cwd(), CATALOGO)} (campo "tratamientos")`);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

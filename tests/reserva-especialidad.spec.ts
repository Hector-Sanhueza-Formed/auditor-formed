import { test, expect, Page, FrameLocator } from '@playwright/test';
import tratamientos from '../data/tratamientos.json';

/**
 * Módulo 3: ¿funciona la reserva por especialidad, tratamiento por tratamiento?
 *
 * Recorre el flujo real que haría un paciente:
 *
 *   /reserva → Por Especialidad → RUT → País/Región
 *            → tratamiento (sucursal "Cualquiera")
 *            → listado de profesionales con sus horas → elegir una hora
 *
 * Se detiene en el paso 3. NUNCA llega al paso 4 ("Reservar"), así que no se
 * crea ninguna reserva.
 *
 * El RUT sale de RUT_PRUEBA en .env, que no se versiona por ser un dato
 * personal. Sin él los tests se saltan con un mensaje explícito.
 */

// El flujo tiene cuatro pantallas encadenadas más el listado: no cabe en el
// timeout global de 45 s pensado para el módulo de listado.
test.describe.configure({ timeout: 180_000 });

// El widget necesita alto: con el viewport por defecto (720 px) los
// desplegables quedan cortados y sus opciones nunca llegan a ser clicables.
test.use({ viewport: { width: 1440, height: 1200 } });

const RUT = process.env.RUT_PRUEBA;

/**
 * Margen entre elegir el tratamiento y pulsar Continuar.
 *
 * Las especialidades grandes (las psicologías, con 38 a 75 profesionales)
 * dejaban el wizard detenido en el paso 2: el botón se habilita antes de que
 * el widget termine de preparar la disponibilidad.
 */
const ESPERA_ANTES_DE_CONTINUAR = 10_000;

type Estado =
  | 'ok'
  | 'sin-profesionales'
  | 'sin-horas'
  | 'hora-no-clicable'
  | 'no-avanza'
  | 'flujo-roto';

function nombreArchivo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** Recorre RUT + país/región hasta dejar visible el selector de tratamiento. */
async function avanzarHastaTratamientos(page: Page): Promise<FrameLocator> {
  await page.goto('/reserva/disponibilidad', { waitUntil: 'domcontentloaded' });
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 45_000 });

  const marco = page.frameLocator('iframe');

  const campoRut = marco.locator('input[placeholder*="11222333"]').first();
  await campoRut.waitFor({ state: 'visible', timeout: 45_000 });
  await campoRut.fill(RUT as string);
  await marco.locator('button', { hasText: /continuar/i }).first().click({ timeout: 20_000 });

  // En ambos desplegables se escribe para filtrar: con la lista completa
  // abierta, la opción queda fuera de vista y el click no la alcanza.
  const pais = marco.locator('input.vs__search[placeholder*="País"]').first();
  await pais.waitFor({ state: 'visible', timeout: 45_000 });
  await pais.click();
  await pais.fill('Chile');
  await page.waitForTimeout(1_500);
  await marco.locator('.vs__dropdown-option', { hasText: /^Chile$/ }).first()
    .click({ timeout: 20_000 });

  const region = marco.locator('input.vs__search[placeholder*="Región"]').first();
  await region.click({ timeout: 20_000 });
  await region.fill('Metropolitana');
  await page.waitForTimeout(1_500);
  await marco.locator('.vs__dropdown-option', { hasText: /Metropolitana/ }).first()
    .click({ timeout: 20_000 });

  await marco.locator('button', { hasText: /continuar/i }).first().click({ timeout: 20_000 });
  await marco.locator('.v-select:visible').first().waitFor({ state: 'visible', timeout: 45_000 });

  return marco;
}

type Disponibilidad = {
  sucursales?: { profesionales?: { nombre: string; horas_disponibles?: string[] }[] }[];
}[];

/**
 * Escucha la respuesta que el propio widget pide para poblar el listado.
 *
 * Es más fiable que leer el DOM: las tarjetas son puro Tailwind genérico, y
 * el botón "Volver" aparece antes de que el listado termine de cargarse, así
 * que esperar por la interfaz produce falsos "sin profesionales".
 */
function escucharDisponibilidad(page: Page): Disponibilidad[] {
  const capturadas: Disponibilidad[] = [];
  page.on('response', async (respuesta) => {
    if (!respuesta.url().includes('obtain_horarios_disponibles')) return;
    try {
      capturadas.push((await respuesta.json()) as Disponibilidad);
    } catch {
      /* respuesta no-JSON: se ignora */
    }
  });
  return capturadas;
}

/**
 * Suma todas las respuestas recibidas: el widget pide la disponibilidad por
 * tramos, así que quedarse solo con la última subestima las horas.
 */
function resumir(respuestas: Disponibilidad[]) {
  const vistos = new Set<string>();
  let horas = 0;

  for (const disponibilidad of respuestas) {
    for (const dia of disponibilidad ?? []) {
      for (const sucursal of dia.sucursales ?? []) {
        for (const prof of sucursal.profesionales ?? []) {
          vistos.add(prof.nombre);
          horas += (prof.horas_disponibles ?? []).length;
        }
      }
    }
  }
  return { profesionales: vistos.size, horas };
}

async function auditarTratamiento(page: Page, tratamiento: string): Promise<Estado> {
  const capturadas = escucharDisponibilidad(page);
  // El widget ya pide disponibilidad antes de elegir tratamiento; solo cuentan
  // las respuestas posteriores al click, o se mezclan datos de otra consulta.
  let desde = 0;
  let marco: FrameLocator;
  try {
    marco = await avanzarHastaTratamientos(page);
  } catch {
    return 'flujo-roto';
  }

  try {
    // La disponibilidad se pide al ELEGIR el tratamiento, no al pulsar
    // Continuar: hay que empezar a contar antes de tocar el desplegable.
    desde = capturadas.length;

    const desplegable = marco.locator('.v-select:visible').first();
    await desplegable.click({ timeout: 20_000 });

    // El menú carga de a 10 opciones, así que hay que filtrar escribiendo.
    await desplegable.locator('input.vs__search').fill(tratamiento);
    await page.waitForTimeout(2_000);

    const opcion = marco.locator('.vs__dropdown-option', { hasText: tratamiento }).first();
    await opcion.waitFor({ state: 'visible', timeout: 20_000 });
    await opcion.click({ timeout: 20_000 });

    // Elegir tratamiento dispara la carga de sucursales y habilita Continuar.
    // El botón se habilita antes de que el widget termine de preparar la
    // disponibilidad, y pulsarlo demasiado pronto deja el wizard clavado en el
    // paso 2, así que se le dan 10 s de margen aunque ya parezca listo.
    const continuar = marco.locator('button', { hasText: /continuar/i }).first();
    await continuar.waitFor({ state: 'visible', timeout: 20_000 });
    await expect(continuar).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(ESPERA_ANTES_DE_CONTINUAR);

    // Sucursal queda en "Cualquiera".
    await continuar.click({ timeout: 20_000 });

    // Haber recibido la respuesta NO significa haber avanzado: el paso 3 se
    // reconoce porque el selector de tratamiento deja de estar en pantalla.
    // Las especialidades con decenas de profesionales tardan en pintarse.
    const limite = Date.now() + 90_000;
    let enPaso3 = false;
    while (Date.now() < limite) {
      if ((await marco.locator('.v-select:visible').count()) === 0) {
        enPaso3 = true;
        break;
      }
      await page.waitForTimeout(1_000);
    }
    if (!enPaso3) {
      // Quedarse en el paso 2 es lo normal cuando la especialidad no tiene a
      // nadie disponible. Solo es un fallo si la agenda SÍ devolvió gente.
      const { profesionales } = resumir(capturadas.slice(desde));
      console.log(
        `   ${tratamiento}: no avanzó al paso 3 — ${profesionales} profesional(es) en la agenda`,
      );
      return profesionales === 0 ? 'sin-profesionales' : 'no-avanza';
    }
    await page.waitForTimeout(3_000); // el listado se pinta después
  } catch {
    return 'flujo-roto';
  }

  const { profesionales, horas } = resumir(capturadas.slice(desde));
  console.log(
    `   ${tratamiento}: ${profesionales} profesional(es), ${horas} hora(s), ` +
      `${capturadas.length - desde} respuesta(s)`,
  );
  if (profesionales === 0) return 'sin-profesionales';
  if (horas === 0) return 'sin-horas';

  // Con la disponibilidad ya confirmada por datos, comprobar que la interfaz
  // también deja elegir una hora. Si esto falla NO es falta de cupo: es que el
  // listado no la muestra o no la deja pulsar, y merece un diagnóstico propio.
  const celdasHora = marco.locator('div.cursor-pointer').filter({ hasText: /^\d{2}:\d{2}$/ });
  try {
    const primera = celdasHora.first();
    await primera.waitFor({ state: 'visible', timeout: 25_000 });
    await primera.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await primera.click({ timeout: 15_000 });
  } catch {
    return 'hora-no-clicable';
  }

  // Hasta aquí: no se avanza al paso 4 ("Reservar"), así que no se reserva nada.
  await page.waitForTimeout(1_000);
  return 'ok';
}

for (const fila of tratamientos) {
  test(`Especialidad: ${fila.tratamiento}`, async ({ page }) => {
    test.skip(!RUT, 'Falta RUT_PRUEBA en .env (copia .env.example)');

    const estado = await auditarTratamiento(page, fila.tratamiento);

    if (estado !== 'ok') {
      await page.screenshot({
        path: `screenshots/especialidad_${nombreArchivo(fila.tratamiento)}.png`,
        fullPage: true,
      });
    }

    if (estado === 'flujo-roto') {
      throw new Error(
        `🔴 "${fila.tratamiento}" — el flujo de reserva por especialidad se cortó ` +
          'antes de mostrar el listado',
      );
    }
    if (estado === 'sin-profesionales') {
      throw new Error(
        `🟡 "${fila.tratamiento}" — la especialidad no ofrece ningún profesional ` +
          '(el wizard se queda en el paso 2, que es lo esperable sin disponibilidad)',
      );
    }
    if (estado === 'no-avanza') {
      throw new Error(
        `🔴 "${fila.tratamiento}" — la agenda ofrece profesionales, pero el wizard ` +
          'no pasa al listado de día y hora',
      );
    }
    if (estado === 'hora-no-clicable') {
      throw new Error(
        `🔴 "${fila.tratamiento}" — la agenda reporta horas, pero el listado no deja ` +
          'seleccionar ninguna',
      );
    }
    if (estado === 'sin-horas') {
      throw new Error(
        `🟡 "${fila.tratamiento}" — hay profesionales listados, pero ninguno con horas`,
      );
    }

    expect(estado).toBe('ok');
  });
}

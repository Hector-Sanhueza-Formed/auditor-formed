import { test, expect, Page, FrameLocator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

type Ficha = { profesional: string; atenciones: string[] };
type Sucursal = { sucursal: string; profesionales: Ficha[] };

/**
 * El mapa se lee en caliente y no con `import`: lo produce
 * `npm run agenda-profesional`, y con un import estático la falta del archivo
 * rompe la carga de TODOS los módulos, no solo de este.
 */
const RUTA_MAPA = path.join(__dirname, '..', 'data', 'agenda-profesional.json');
const mapa: Sucursal[] = fs.existsSync(RUTA_MAPA)
  ? (JSON.parse(fs.readFileSync(RUTA_MAPA, 'utf8')) as Sucursal[])
  : [];

/**
 * Módulo 4: ¿se puede reservar por profesional, en cada sucursal y atención?
 *
 * Recorre el flujo real que haría un paciente:
 *
 *   /reserva → Por Profesional → sucursal → profesional → atención
 *            → calendario  ← AQUÍ SE DETIENE
 *
 * Comprueba que el calendario ofrezca al menos un día con cupo, y ahí termina:
 * no elige día ni hora, no pulsa Continuar y nunca alcanza el paso que pide el
 * RUT. Por eso este módulo tampoco necesita `.env`.
 *
 * Una comprobación por combinación sucursal × profesional × atención, según
 * `data/agenda-profesional.json` (lo genera `npm run agenda-profesional`).
 */

// Cinco pantallas encadenadas más el calendario: no cabe en el timeout global.
test.describe.configure({ timeout: 240_000 });

// El widget necesita alto: con 720 px los desplegables quedan cortados.
test.use({ viewport: { width: 1440, height: 1200 } });

/** Hasta cuántos meses hacia adelante buscar un día con cupo. */
const MESES_A_REVISAR = 3;

/**
 * Margen antes de pulsar Continuar. El botón se habilita antes de que el
 * widget termine de preparar el paso siguiente; sin esta espera el wizard se
 * queda detenido sin avisar (la misma trampa del flujo por especialidad).
 */
const ESPERA_ANTES_DE_CONTINUAR = 6_000;

type Estado =
  | 'ok'
  | 'sin-sucursal'
  | 'sin-profesional'
  | 'sin-atencion'
  | 'sin-dias';

const DIAGNOSTICO: Record<Estado, string> = {
  'ok': 'llega al calendario con al menos un día disponible',
  'sin-sucursal': 'la sucursal ya no aparece en el desplegable',
  'sin-profesional': 'el profesional ya no aparece en esa sucursal',
  'sin-atencion': 'la atención ya no aparece para ese profesional',
  'sin-dias': `ningún día con cupo en los próximos ${MESES_A_REVISAR} meses`,
};

function nombreArchivo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .slice(0, 80);
}

function diasDisponibles(marco: FrameLocator) {
  return marco.locator(
    '.vdp-datepicker__calendar:visible span.cell.day:not(.disabled):not(.blank)',
  );
}

/**
 * El calendario pide la disponibilidad del mes por red y recién entonces marca
 * los días sin cupo. Leer antes devuelve días "libres" que no lo son.
 */
async function contarDiasEstable(page: Page, marco: FrameLocator): Promise<number> {
  await page.waitForTimeout(3_000);
  let previo = -1;
  for (let intento = 0; intento < 5; intento++) {
    const actual = await diasDisponibles(marco).count();
    if (actual === previo) return actual;
    previo = actual;
    await page.waitForTimeout(1_200);
  }
  return previo;
}

/**
 * Selección y avance viven en el ayudante compartido con el generador del
 * mapa: el desplegable está virtualizado (solo existen en el DOM las filas
 * visibles), así que buscar la opción "entre las que hay" daba por ausentes a
 * los profesionales del final del listado. Tener una sola implementación evita
 * que el test y el generador discrepen sobre quién existe.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const F = require('../scripts/flujo-profesional.js');

function elegirPorTexto(page: Page, marco: FrameLocator, texto: string): Promise<boolean> {
  return F.elegirPorTexto(page, marco, texto);
}

function continuar(page: Page, marco: FrameLocator): Promise<void> {
  return F.continuar(page, marco, ESPERA_ANTES_DE_CONTINUAR);
}

async function auditar(
  page: Page,
  sucursal: string,
  profesional: string,
  atencion: string,
): Promise<Estado> {
  await page.goto('/reserva/profesional', { waitUntil: 'domcontentloaded' });
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 45_000 });

  const marco = page.frameLocator('iframe');
  await marco.locator('.wizard-nav').waitFor({ state: 'visible', timeout: 45_000 });
  await page.waitForTimeout(2_500);

  // ---- Paso 1: sucursal --------------------------------------------------
  if (!(await elegirPorTexto(page, marco, sucursal))) return 'sin-sucursal';
  await continuar(page, marco);
  await page.waitForTimeout(4_000);

  // ---- Paso 2: profesional ----------------------------------------------
  if (!(await elegirPorTexto(page, marco, profesional))) return 'sin-profesional';
  await continuar(page, marco);
  await page.waitForTimeout(4_000);

  // ---- Paso 3: atención --------------------------------------------------
  if (!(await elegirPorTexto(page, marco, atencion))) return 'sin-atencion';
  await continuar(page, marco);

  // ---- Paso 4: basta con que el calendario ofrezca un día con cupo -------
  const calendario = marco.locator('.vdp-datepicker__calendar:visible').first();
  try {
    await calendario.waitFor({ state: 'visible', timeout: 45_000 });
  } catch {
    return 'sin-dias';
  }

  let dias = 0;
  for (let mes = 0; mes < MESES_A_REVISAR; mes++) {
    dias = await contarDiasEstable(page, marco);
    if (dias > 0) break;

    const siguiente = marco.locator('.vdp-datepicker__calendar:visible header span.next').first();
    const clase = (await siguiente.getAttribute('class').catch(() => null)) ?? '';
    if (clase.includes('disabled')) break;
    await siguiente.click({ timeout: 10_000 }).catch(() => undefined);
  }
  if (dias === 0) return 'sin-dias';

  // Hasta aquí. No se elige día ni hora, no se pulsa Continuar y nunca se
  // llega al paso de datos: la auditoría termina con el calendario a la vista.
  return 'ok';
}

if (mapa.length === 0) {
  test('Falta el mapa de agendas', () => {
    test.skip(true, 'Genera data/agenda-profesional.json con: npm run agenda-profesional');
  });
}

for (const sucursal of mapa) {
  for (const ficha of sucursal.profesionales) {
    for (const atencion of ficha.atenciones) {
      const etiqueta =
        `${sucursal.sucursal.replace('Formed/ ', '')} · ` +
        `${ficha.profesional.split('(')[0].trim()} · ${atencion}`;

      test(`Reserva profesional: ${etiqueta}`, async ({ page }) => {
        const estado = await auditar(page, sucursal.sucursal, ficha.profesional, atencion);

        if (estado !== 'ok') {
          await page.screenshot({
            path: `screenshots/prof_${nombreArchivo(etiqueta)}.png`,
            fullPage: true,
          });
          throw new Error(`🔴 ${etiqueta} — ${DIAGNOSTICO[estado]}`);
        }

        expect(estado).toBe('ok');
      });
    }
  }
}

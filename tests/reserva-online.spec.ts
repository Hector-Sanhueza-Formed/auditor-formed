import { test, expect, Page, FrameLocator } from '@playwright/test';
import agendas from '../data/agendas.json';

/**
 * Módulo 2: ¿cada profesional está habilitado para reserva online?
 *
 * Recorre el flujo real que haría un paciente:
 *
 *   /reserva/<id> → [elegir sucursal] → elegir atención → Continuar
 *                 → elegir día con cupo → elegir hora → Continuar
 *                 → se detiene en el paso "Ingrese sus datos"
 *
 * NUNCA completa el formulario: llegar a ese paso no crea ninguna reserva.
 *
 * La agenda es un iframe de agendamiento.reservo.cl embebido en formed.cl,
 * el mismo widget público que ve cualquier paciente.
 */

// El recorrido (widget + varias combinaciones + calendario) no cabe en el
// timeout global de 45 s pensado para el módulo de listado.
test.describe.configure({ timeout: 300_000 });

/** Hasta cuántos meses hacia adelante buscar un día con cupo. */
const MESES_A_REVISAR = 3;

/**
 * Cuántas opciones del primer desplegable probar. Los profesionales que
 * atienden en varias sucursales tienen un paso extra al principio, y puede
 * haber cupo en una sucursal y no en otra: quedarse con la primera daría
 * rojos falsos.
 */
const COMBINACIONES_A_PROBAR = 4;

/** El wizard tiene 3 o 4 pasos según el profesional. */
const MAX_PASOS_PREVIOS = 4;

type Estado =
  | 'ok'
  | 'sin-agenda'
  | 'sin-iframe'
  | 'sin-atenciones'
  | 'sin-dias'
  | 'sin-horas'
  | 'no-avanza';

const DIAGNOSTICO: Record<Estado, string> = {
  'ok': 'reserva online operativa',
  'sin-agenda': 'no tiene agenda configurada (sin url_agendamiento en la API)',
  'sin-iframe': 'la página de reserva no cargó el widget de agenda',
  'sin-atenciones': 'el widget cargó pero no ofrece ninguna atención',
  'sin-dias': `ninguna sucursal ofrece días con cupo en los próximos ${MESES_A_REVISAR} meses`,
  'sin-horas': 'hay días con cupo, pero ninguno ofrece horas',
  'no-avanza': 'con día y hora elegidos, el wizard no llegó al paso de datos',
};

/** Prioridad al informar: el problema más específico gana. */
const GRAVEDAD: Estado[] = [
  'no-avanza',
  'sin-horas',
  'sin-dias',
  'sin-atenciones',
  'sin-iframe',
  'sin-agenda',
  'ok',
];

function nombreArchivo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** Días del mes visible que no están deshabilitados ni en blanco. */
function diasDisponibles(marco: FrameLocator) {
  return marco.locator(
    '.vdp-datepicker__calendar:visible span.cell.day:not(.disabled):not(.blank)',
  );
}

function calendarioVisible(marco: FrameLocator) {
  return marco.locator('.vdp-datepicker__calendar:visible span.cell.day');
}

/**
 * El widget pide la disponibilidad del mes por red y recién entonces marca
 * como `disabled` los días sin cupo. Leer antes de que termine devuelve días
 * "libres" que no lo son, así que se espera a que la cuenta se repita.
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
 * Avanza el wizard eligiendo opciones hasta llegar al calendario.
 * `primeraOpcion` indica qué opción tomar en el PRIMER desplegable
 * (la sucursal, cuando el profesional atiende en varias).
 */
async function llegarAlCalendario(
  page: Page,
  marco: FrameLocator,
  primeraOpcion: number,
): Promise<{ fallo: Estado | null; opcionesPrimerPaso: number }> {
  let opcionesPrimerPaso = 1;

  for (let paso = 0; paso < MAX_PASOS_PREVIOS; paso++) {
    if ((await calendarioVisible(marco).count()) > 0) {
      return { fallo: null, opcionesPrimerPaso }; // ya llegamos
    }

    const desplegable = marco.locator('.nq-field__control--select:visible').first();
    if ((await desplegable.count()) === 0) {
      return { fallo: 'sin-atenciones', opcionesPrimerPaso };
    }

    await desplegable.click({ timeout: 15_000 });

    const opciones = marco.locator('[role="option"]');
    try {
      await opciones.first().waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      return { fallo: 'sin-atenciones', opcionesPrimerPaso };
    }

    const total = await opciones.count();
    // Cuántas sucursales/atenciones ofrece el primer paso: sirve para saber
    // si vale la pena reintentar con otra combinación.
    if (paso === 0) opcionesPrimerPaso = total;

    const indice = paso === 0 ? Math.min(primeraOpcion, total - 1) : 0;
    await opciones.nth(indice).click({ timeout: 15_000 });

    await marco.locator('button', { hasText: 'Continuar' }).first().click({ timeout: 15_000 });
    await page.waitForTimeout(2_500);
  }

  const llego = (await calendarioVisible(marco).count()) > 0;
  return { fallo: llego ? null : 'sin-dias', opcionesPrimerPaso };
}

/** Recorre el flujo con una combinación concreta del primer desplegable. */
async function intentarCombinacion(
  page: Page,
  id: number,
  primeraOpcion: number,
): Promise<{ estado: Estado; opcionesPrimerPaso: number }> {
  await page.goto(`/reserva/${id}`, { waitUntil: 'domcontentloaded' });

  // El iframe lo inserta React tras resolver los datos del profesional.
  try {
    await page.locator('iframe.reserva-iframe').waitFor({ state: 'attached', timeout: 30_000 });
  } catch {
    return { estado: 'sin-iframe', opcionesPrimerPaso: 0 };
  }

  const marco = page.frameLocator('iframe.reserva-iframe');
  try {
    await marco.locator('.wizard-nav').waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    return { estado: 'sin-iframe', opcionesPrimerPaso: 0 };
  }

  const { fallo, opcionesPrimerPaso } = await llegarAlCalendario(page, marco, primeraOpcion);
  if (fallo) return { estado: fallo, opcionesPrimerPaso };

  // ---- Buscar un mes con días con cupo ----------------------------------
  let dias = 0;
  for (let mes = 0; mes < MESES_A_REVISAR; mes++) {
    dias = await contarDiasEstable(page, marco);
    if (dias > 0) break;

    const siguiente = marco.locator('.vdp-datepicker__calendar:visible header span.next').first();
    const clase = (await siguiente.getAttribute('class').catch(() => null)) ?? '';
    if (clase.includes('disabled')) break;
    await siguiente.click({ timeout: 10_000 }).catch(() => undefined);
  }
  if (dias === 0) return { estado: 'sin-dias', opcionesPrimerPaso };

  // ---- Un día con horas -------------------------------------------------
  const horas = marco.locator('div.custom-timeslot-border');
  let hayHoras = false;
  for (let i = 0; i < Math.min(dias, 3); i++) {
    try {
      await diasDisponibles(marco).nth(i).click({ timeout: 15_000 });
      await horas.first().waitFor({ state: 'visible', timeout: 15_000 });
      hayHoras = true;
      break;
    } catch {
      continue;
    }
  }
  if (!hayHoras) return { estado: 'sin-horas', opcionesPrimerPaso };

  // ---- Avanzar al paso de datos y DETENERSE -----------------------------
  try {
    await horas.first().click({ timeout: 15_000 });
    // El widget necesita un instante para registrar la hora elegida: pulsar
    // Continuar de inmediato deja el wizard sin avanzar.
    await page.waitForTimeout(2_000);
    await marco.locator('button', { hasText: 'Continuar' }).first().click({ timeout: 15_000 });
    // El índice del paso varía: es 2 con wizard de 3 pasos y 3 cuando hay
    // selección de sucursal previa, así que se busca por prefijo.
    await expect(marco.locator('[id^="step-Ingresesusdatos"]').first()).toHaveClass(
      /checked|active/,
      { timeout: 45_000 },
    );
  } catch {
    return { estado: 'no-avanza', opcionesPrimerPaso };
  }

  // Hasta aquí. No se rellena ni se envía nada: sin datos no hay reserva.
  return { estado: 'ok', opcionesPrimerPaso };
}

async function auditarReserva(page: Page, id: number): Promise<Estado> {
  let peor: Estado = 'sin-iframe';

  for (let opcion = 0; opcion < COMBINACIONES_A_PROBAR; opcion++) {
    const { estado, opcionesPrimerPaso } = await intentarCombinacion(page, id, opcion);
    if (estado === 'ok') return 'ok';

    // Nos quedamos con el diagnóstico más específico visto hasta ahora.
    if (GRAVEDAD.indexOf(estado) < GRAVEDAD.indexOf(peor)) peor = estado;

    // Sin más sucursales que probar, no tiene sentido reintentar.
    if (opcion + 1 >= opcionesPrimerPaso) break;
  }

  return peor;
}

for (const prof of agendas) {
  // El id va en el título porque la API tiene nombres repetidos
  // (p. ej. Juan Pablo Prudencio Robres aparece con id 2 y 267).
  test(`Reserva online: ${prof.nombre} [${prof.id}]`, async ({ page }) => {
    const estado: Estado = prof.tieneAgenda ? await auditarReserva(page, prof.id) : 'sin-agenda';

    if (estado !== 'ok') {
      await page.screenshot({
        path: `screenshots/reserva_${prof.id}_${nombreArchivo(prof.nombre)}.png`,
        fullPage: true,
      });
      throw new Error(`🔴 ${prof.nombre} (id ${prof.id}) — ${DIAGNOSTICO[estado]}`);
    }

    expect(estado).toBe('ok');
  });
}

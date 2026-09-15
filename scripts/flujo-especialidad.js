/**
 * Recorrido del flujo "Reserva por Especialidad" de formed.cl.
 *
 *   /reserva → Por Especialidad → RUT → País/Región
 *            → tratamiento + sucursal → listado de profesionales y horas
 *
 * Se detiene siempre en el paso 3 (día y hora). NUNCA llega al paso 4
 * ("Reservar"), así que no se crea ninguna reserva.
 *
 * La agenda es un iframe de agendamiento.reservo.cl embebido en formed.cl.
 * Además de recorrer la interfaz, se escucha la respuesta de
 * `obtain_horarios_disponibles`, que el propio widget pide y que trae
 * sucursales, profesionales y horas ya estructurados: raspar las clases
 * Tailwind del listado sería mucho más frágil.
 */

const URL_DISPONIBILIDAD = 'https://formed.cl/reserva/disponibilidad';

/** El RUT vive en .env (no versionado): es un dato personal. */
function rutDePrueba() {
  const rut = process.env.RUT_PRUEBA;
  if (!rut) {
    throw new Error(
      'Falta RUT_PRUEBA. Copia .env.example como .env y completa el RUT ' +
        'de un paciente ya registrado en la agenda.',
    );
  }
  return rut;
}

/**
 * Empieza a escuchar las respuestas del widget.
 *
 * `disponibilidad` acumula los listados de profesionales y horas.
 * `totalTratamientos` sale del `count` que devuelve el endpoint paginado de
 * tratamientos: el desplegable los carga por scroll infinito, así que sin ese
 * número no se sabe cuándo se terminó de cargar la lista.
 */
function escucharDisponibilidad(page) {
  const capturadas = [];
  capturadas.totalTratamientos = 0;

  page.on('response', async (respuesta) => {
    const url = respuesta.url();
    try {
      if (url.includes('obtain_horarios_disponibles')) {
        capturadas.push(await respuesta.json());
      } else if (url.includes('obtain_tratamientos_agenda_online')) {
        const cuerpo = await respuesta.json();
        if (typeof cuerpo.count === 'number') capturadas.totalTratamientos = cuerpo.count;
      }
    } catch {
      /* respuesta no-JSON: se ignora */
    }
  });

  return capturadas;
}

/**
 * Avanza hasta el paso 2 (elección de tratamiento), que es común a todos
 * los tratamientos: RUT, país y región.
 */
async function avanzarHastaTratamientos(page) {
  await page.goto(URL_DISPONIBILIDAD, { waitUntil: 'domcontentloaded' });
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 45_000 });

  const marco = page.frameLocator('iframe');

  // ---- Paso 1: RUT ------------------------------------------------------
  const campoRut = marco.locator('input[placeholder*="11222333"]').first();
  await campoRut.waitFor({ state: 'visible', timeout: 45_000 });
  await campoRut.fill(rutDePrueba());
  await marco.locator('button', { hasText: /continuar/i }).first().click({ timeout: 20_000 });

  // ---- Paso 1b: país y región -------------------------------------------
  const pais = marco.locator('input.vs__search[placeholder*="País"]').first();
  await pais.waitFor({ state: 'visible', timeout: 45_000 });
  await pais.click();
  await pais.fill('Chile');
  await marco.locator('.vs__dropdown-option', { hasText: /^Chile$/ }).first()
    .click({ timeout: 20_000 });

  const region = marco.locator('input.vs__search[placeholder*="Región"]').first();
  await region.click({ timeout: 20_000 });
  await marco.locator('.vs__dropdown-option', { hasText: /Metropolitana/ }).first()
    .click({ timeout: 20_000 });

  await marco.locator('button', { hasText: /continuar/i }).first().click({ timeout: 20_000 });

  // El paso 2 está listo cuando aparece el desplegable de tratamiento.
  await marco.locator('.v-select:visible').first().waitFor({ state: 'visible', timeout: 45_000 });

  return marco;
}

/**
 * Lista todos los tratamientos del desplegable.
 *
 * El menú los carga de a 10 por scroll infinito, así que hay que bajar hasta
 * completar el `count` que informó la API y esperar entre tirón y tirón a que
 * llegue la página siguiente.
 */
async function listarTratamientos(page, marco, capturadas) {
  await marco.locator('.v-select:visible').first().click({ timeout: 20_000 });
  await marco.locator('.vs__dropdown-option').first().waitFor({ state: 'visible', timeout: 20_000 });

  const frame = page.frames().find((f) => f.url().includes('reservo.cl'));
  const leer = () =>
    frame.evaluate(() =>
      [...document.querySelectorAll('.vs__dropdown-menu .vs__dropdown-option')].map((o) =>
        o.textContent.trim(),
      ),
    );

  const vistos = new Set(await leer());
  const esperado = () => capturadas?.totalTratamientos || 0;

  for (let vuelta = 0; vuelta < 25; vuelta++) {
    if (esperado() && vistos.size >= esperado()) break;

    const antes = vistos.size;
    await frame.evaluate(() => {
      const menu = document.querySelector('.vs__dropdown-menu');
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await page.waitForTimeout(1_200); // margen para que llegue la página siguiente
    (await leer()).forEach((t) => vistos.add(t));

    if (vistos.size === antes && vuelta > 2) break; // ya no llega nada nuevo
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  return [...vistos].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));
}

/**
 * Elige un tratamiento (sucursal queda en "Cualquiera") y avanza al paso 3.
 * Devuelve las sucursales/profesionales/horas que el widget reporta.
 */
async function abrirDisponibilidad(page, marco, tratamiento, capturadas) {
  const desplegable = marco.locator('.v-select:visible').first();
  await desplegable.click({ timeout: 20_000 });

  // El menú solo carga 10 opciones por vez, así que no basta con buscarlas en
  // el DOM: hay que escribir en el buscador del selector para que filtre.
  const buscador = desplegable.locator('input.vs__search');
  await buscador.fill(tratamiento);
  await page.waitForTimeout(2_000); // el filtrado consulta a la API

  const opcion = marco.locator('.vs__dropdown-option', { hasText: tratamiento }).first();
  await opcion.waitFor({ state: 'visible', timeout: 20_000 });
  await opcion.click({ timeout: 20_000 });

  // Que Continuar esté habilitado no significa que el widget esté listo: se
  // habilita antes de terminar de preparar la disponibilidad, y pulsarlo
  // entonces deja el wizard clavado en el paso 2. Las especialidades grandes
  // (las psicologías) necesitan este margen.
  const antes = capturadas.length;
  const continuar = marco.locator('button', { hasText: /continuar/i }).first();
  await continuar.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(10_000);
  await continuar.click({ timeout: 20_000 });

  // Esperar la respuesta de disponibilidad que dispara el paso 3.
  const limite = Date.now() + 45_000;
  while (capturadas.length === antes && Date.now() < limite) {
    await page.waitForTimeout(500);
  }
  return capturadas[capturadas.length - 1] ?? null;
}

/**
 * Deja el wizard listo para probar otro tratamiento.
 *
 * "Volver" retrocede un paso, así que dónde aterriza depende de hasta dónde se
 * llegó: desde el paso 3 cae en el selector de tratamiento (y no hay nada más
 * que hacer), pero desde el paso 2 cae en el RUT y hay que reingresar los
 * datos. Aun así sale más barato que recargar: el iframe tarda en montarse.
 */
async function reiniciarParaOtroTratamiento(page, marco) {
  await marco.locator('button', { hasText: /volver/i }).first().click({ timeout: 20_000 });

  // Dónde aterriza depende de hasta dónde se llegó, y cuánto tarda en pintarse
  // depende del tamaño del listado que se está dejando atrás: tras una
  // especialidad con decenas de profesionales no basta una espera fija.
  const campoRut = marco.locator('input[placeholder*="11222333"]');
  const limite = Date.now() + 45_000;
  let enPaso2 = false;
  let enPaso1 = false;

  while (Date.now() < limite) {
    enPaso2 = (await marco.locator('.v-select:visible').count()) > 0;
    enPaso1 = (await campoRut.count()) > 0 && (await campoRut.first().isVisible());
    if (enPaso2 || enPaso1) break;
    await page.waitForTimeout(1_000);
  }

  if (enPaso2) return; // ya está listo para elegir otro tratamiento
  if (!enPaso1) throw new Error('tras "Volver" no apareció ni el paso 1 ni el paso 2');

  await campoRut.first().fill(rutDePrueba());
  await marco.locator('button', { hasText: /continuar/i }).first().click({ timeout: 20_000 });

  const pais = marco.locator('input.vs__search[placeholder*="País"]').first();
  await pais.waitFor({ state: 'visible', timeout: 30_000 });
  await pais.click();
  await pais.fill('Chile');
  await marco.locator('.vs__dropdown-option', { hasText: /^Chile$/ }).first()
    .click({ timeout: 20_000 });

  const region = marco.locator('input.vs__search[placeholder*="Región"]').first();
  await region.click({ timeout: 20_000 });
  await marco.locator('.vs__dropdown-option', { hasText: /Metropolitana/ }).first()
    .click({ timeout: 20_000 });

  await marco.locator('button', { hasText: /continuar/i }).first().click({ timeout: 20_000 });
  await marco.locator('.v-select:visible').first().waitFor({ state: 'visible', timeout: 45_000 });
}

/** Aplana la respuesta del widget a una lista de profesionales con horas. */
function profesionalesDe(disponibilidad) {
  const porNombre = new Map();
  for (const dia of disponibilidad ?? []) {
    for (const sucursal of dia.sucursales ?? []) {
      for (const prof of sucursal.profesionales ?? []) {
        const horas = (prof.horas_disponibles ?? []).length;
        const previo = porNombre.get(prof.nombre) ?? {
          nombre: prof.nombre,
          agenda: prof.agenda,
          sucursales: new Set(),
          horas: 0,
        };
        previo.sucursales.add(sucursal.nombre);
        previo.horas += horas;
        porNombre.set(prof.nombre, previo);
      }
    }
  }
  return [...porNombre.values()].map((p) => ({
    nombre: p.nombre,
    agenda: p.agenda,
    sucursales: [...p.sucursales],
    horas: p.horas,
  }));
}

module.exports = {
  URL_DISPONIBILIDAD,
  rutDePrueba,
  escucharDisponibilidad,
  avanzarHastaTratamientos,
  listarTratamientos,
  abrirDisponibilidad,
  reiniciarParaOtroTratamiento,
  profesionalesDe,
};

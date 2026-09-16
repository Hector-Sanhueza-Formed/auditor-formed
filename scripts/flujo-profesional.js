/**
 * Recorrido del flujo "Reserva por Profesional" de formed.cl.
 *
 *   /reserva/profesional → sucursal → profesional → atención
 *                        → día y hora → [Ingrese sus datos]
 *
 * Se detiene al llegar al paso de datos: ahí el widget pide el RUT, y no se
 * ingresa ninguno. Sin datos del paciente no se crea ninguna reserva.
 *
 * Es un widget distinto al de "Por Especialidad": usa los mismos componentes
 * que la reserva desde la ficha del profesional (`.nq-field__control--select`,
 * opciones `.nqs-option`) y un wizard de cinco pasos, cada uno en su pantalla.
 *
 * TRAMPA PRINCIPAL: el menú está virtualizado. `.nqs-option` solo contiene lo
 * que cabe en pantalla (unas 28 filas); al bajar carga las siguientes y borra
 * las de arriba. Leerlo de una sola vez daba 28 profesionales en Concepción
 * cuando en realidad hay 39. Por eso aquí nunca se lee ni se elige "lo que hay
 * en el DOM": se enumera bajando hasta el final, y se selecciona filtrando con
 * el buscador del propio desplegable.
 */

const URL_PROFESIONAL = 'https://formed.cl/reserva/profesional';

/** Abre la página y espera a que el wizard esté montado. */
async function abrirWizard(page) {
  await page.goto(URL_PROFESIONAL, { waitUntil: 'domcontentloaded' });
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 45_000 });

  const marco = page.frameLocator('iframe');
  await marco.locator('.wizard-nav').waitFor({ state: 'visible', timeout: 45_000 });
  await page.waitForTimeout(2_500);
  return marco;
}

/** El iframe del widget, para evaluar JavaScript dentro de él. */
function marcoReservo(page) {
  const frame = page.frames().find((f) => f.url().includes('reservo.cl'));
  if (!frame) throw new Error('no se encontró el iframe de reservo.cl');
  return frame;
}

/** Lee las opciones pintadas ahora mismo en el menú visible. */
function leerPintadas(frame) {
  return frame.evaluate(() => {
    // El menú va en position:fixed, así que offsetParent es null aunque se vea:
    // la visibilidad se decide por si ocupa espacio en pantalla.
    const menu = [...document.querySelectorAll('.nqs-menu')].find((m) => m.getClientRects().length > 0);
    if (!menu) return [];
    return [...menu.querySelectorAll('.nqs-option')].map((o) =>
      o.textContent.replace(/\s+/g, ' ').trim(),
    );
  });
}

function normalizar(texto) {
  return texto.replace(/\s+/g, ' ').trim();
}

/** Abre el desplegable visible. */
async function abrirDesplegable(page, marco) {
  await marco.locator('.nq-field__control--select:visible').first().click({ timeout: 20_000 });
  await page.waitForTimeout(3_000);
}

/**
 * Todas las opciones del desplegable visible.
 *
 * Baja hasta el fondo tantas veces como haga falta acumulando lo que aparece:
 * el menú carga por tandas y descarta lo que queda fuera de pantalla, así que
 * una sola lectura devuelve una lista truncada.
 */
async function opcionesVisibles(page, marco) {
  await abrirDesplegable(page, marco);
  const frame = marcoReservo(page);

  const vistas = new Set((await leerPintadas(frame)).filter(Boolean));
  let rondasSinNovedad = 0;

  for (let vuelta = 0; vuelta < 60 && rondasSinNovedad < 6; vuelta++) {
    const antes = vistas.size;
    await frame.evaluate(() => {
      // El menú va en position:fixed, así que offsetParent es null aunque se vea:
    // la visibilidad se decide por si ocupa espacio en pantalla.
    const menu = [...document.querySelectorAll('.nqs-menu')].find((m) => m.getClientRects().length > 0);
      if (menu) menu.scrollTop = menu.scrollHeight;
    });
    await page.waitForTimeout(700);
    (await leerPintadas(frame)).filter(Boolean).forEach((o) => vistas.add(o));
    rondasSinNovedad = vistas.size === antes ? rondasSinNovedad + 1 : 0;
  }

  return [...vistas];
}

function escaparRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Términos con que intentar filtrar, del más específico al más laxo.
 *
 * El buscador hace coincidencia por texto, así que la etiqueta completa
 * ("Dra. Paola Nuñez Contreras (Neurología Infantil) (0 - 15 Años )") no
 * siempre encaja: se prueba primero el nombre sin título ni paréntesis y
 * después la palabra más larga, que basta para acotar el listado.
 */
function terminosDeBusqueda(texto) {
  const limpio = normalizar(
    texto
      .replace(/\([^)]*\)/g, '')
      .replace(/^\s*(Dra?\.|Ps\.|Mg\.|Klga?\.|Nut\.|T\.O\.|Mat\.)\s*/i, ''),
  );
  const palabras = limpio
    .split(/[\s/]+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((p) => p.length > 2);
  const masLarga = [...palabras].sort((a, b) => b.length - a.length)[0];
  return [...new Set([limpio, masLarga].filter(Boolean))];
}

/** La opción cuyo texto es exactamente el buscado. */
function opcionExacta(marco, texto) {
  return marco.locator('.nqs-option', {
    hasText: new RegExp('^\\s*' + escaparRegex(normalizar(texto)) + '\\s*$'),
  });
}

/**
 * Elige en el desplegable visible la opción con ese texto exacto.
 * Devuelve false si la opción ya no existe.
 */
async function elegirPorTexto(page, marco, texto) {
  await abrirDesplegable(page, marco);
  const buscador = marco.locator('input.nqs-search:visible').first();
  const hayBuscador = (await buscador.count()) > 0;

  for (const termino of terminosDeBusqueda(texto)) {
    if (hayBuscador) {
      await buscador.fill(termino);
      await page.waitForTimeout(3_000);
    }
    const opcion = opcionExacta(marco, texto);
    if ((await opcion.count()) > 0) {
      await opcion.first().click({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      return true;
    }
    if (!hayBuscador) break;
  }

  // Último recurso: el buscador no acotó nada, así que se recorre el listado.
  if (hayBuscador) {
    await buscador.fill('');
    await page.waitForTimeout(2_000);
  }
  const frame = marcoReservo(page);
  const objetivo = normalizar(texto);
  for (let vuelta = 0; vuelta < 40; vuelta++) {
    if ((await leerPintadas(frame)).includes(objetivo)) {
      await opcionExacta(marco, texto).first().click({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      return true;
    }
    const bajo = await frame.evaluate(() => {
      // El menú va en position:fixed, así que offsetParent es null aunque se vea:
    // la visibilidad se decide por si ocupa espacio en pantalla.
    const menu = [...document.querySelectorAll('.nqs-menu')].find((m) => m.getClientRects().length > 0);
      if (!menu) return false;
      const antes = menu.scrollTop;
      menu.scrollTop += Math.max(120, menu.clientHeight - 60);
      return menu.scrollTop !== antes;
    });
    if (!bajo) break;
    await page.waitForTimeout(600);
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  return false;
}

/**
 * Pulsa Continuar.
 *
 * Igual que en el flujo por especialidad, el botón se habilita antes de que el
 * widget termine de cargar lo del paso siguiente: pulsarlo demasiado pronto
 * deja el wizard sin avanzar.
 */
async function continuar(page, marco, espera = 3_000) {
  const boton = marco.locator('button', { hasText: /continuar/i }).first();
  await boton.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(espera);
  await boton.click({ timeout: 20_000 });
}

/** Retrocede un paso del wizard. */
async function volver(page, marco) {
  await marco.locator('button', { hasText: /volver/i }).first().click({ timeout: 20_000 });
  await page.waitForTimeout(3_500);
}

/** Título del paso activo, para saber dónde quedó el wizard. */
async function pasoActivo(page) {
  const frame = page.frames().find((f) => f.url().includes('reservo.cl'));
  if (!frame) return '(sin iframe)';
  return frame
    .evaluate(() => {
      const activo = [...document.querySelectorAll('.wizard-nav li')].find((li) =>
        li.className.includes('active'),
      );
      return activo?.querySelector('.wizard-icon-circle')?.id ?? '(sin paso activo)';
    })
    .catch(() => '(error)');
}

module.exports = {
  URL_PROFESIONAL,
  abrirWizard,
  opcionesVisibles,
  elegirPorTexto,
  continuar,
  volver,
  pasoActivo,
};

import { test, expect, Page } from '@playwright/test';
import profesionales from '../data/profesionales.json';

/**
 * MVP de auditoría: por cada profesional del catálogo esperado
 * (data/profesionales.json) se busca en formed.cl/profesionales
 * y se verifica que aparezca en los resultados.
 *
 * 🟢 encontrado    → test verde
 * 🔴 no encontrado → test rojo + captura en screenshots/
 */

/** Quita tildes, colapsa espacios y pasa a minúsculas, para comparar nombres sin falsos rojos. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Nombre de archivo seguro en Windows. */
function nombreArchivo(texto: string): string {
  return normalizar(texto).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Por defecto solo se guardan las capturas de los tests en rojo, para que
 * screenshots/ sea la lista de problemas y no 217 imágenes de todo lo que ya
 * funciona. Con CAPTURAS=todas se guardan todas (~45 MB por corrida).
 */
const CAPTURAR_TODO = process.env.CAPTURAS === 'todas';

type Resultado = 'encontrado' | 'sin-resultados' | 'no-coincide';

/**
 * Abre el listado filtrado por nombre y espera a que la búsqueda resuelva.
 *
 * La página es Next.js y re-renderiza tras hidratar, así que no basta con
 * contar tarjetas una vez: se espera dentro del navegador hasta que aparezca
 * el nombre buscado o hasta que el listado declare "Sin resultados".
 */
async function buscarProfesional(page: Page, nombre: string): Promise<Resultado> {
  await page.goto(`/profesionales?nombre=${encodeURIComponent(nombre)}`, {
    waitUntil: 'domcontentloaded',
  });

  const objetivo = normalizar(nombre);

  const resuelto = await page
    .waitForFunction(
      (buscado) => {
        const norm = (t: string) =>
          t
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const nombres = Array.from(document.querySelectorAll('.pro-nombre-real')).map((e) =>
          norm(e.textContent || ''),
        );

        if (nombres.some((n) => n.includes(buscado))) return 'encontrado';
        if (/sin resultados/i.test(document.body.innerText)) return 'sin-resultados';
        return false; // seguir esperando: la página aún está resolviendo
      },
      objetivo,
      { timeout: 20_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<Resultado>)
    .catch(() => 'no-coincide' as Resultado);

  return resuelto;
}

for (const prof of profesionales) {
  test(`Profesional existe: ${prof.nombre}`, async ({ page }) => {
    const resultado = await buscarProfesional(page, prof.nombre);

    // Evidencia: solo de los fallos, salvo CAPTURAS=todas.
    if (CAPTURAR_TODO || resultado !== 'encontrado') {
      await page.screenshot({
        path: `screenshots/${nombreArchivo(prof.nombre)}.png`,
        fullPage: true,
      });
    }

    if (resultado === 'sin-resultados') {
      throw new Error(`🔴 "${prof.nombre}" no aparece: la búsqueda devolvió 0 resultados`);
    }
    if (resultado === 'no-coincide') {
      const total = await page.locator('.pro-card').count();
      throw new Error(
        `🔴 "${prof.nombre}" no aparece: la búsqueda devolvió ${total} resultado(s), ` +
          `ninguno con ese nombre`,
      );
    }

    expect(resultado).toBe('encontrado');
  });
}

/**
 * Control negativo: si el buscador dejara de filtrar, todos los tests de
 * arriba pasarían igual. Este test confirma que un nombre inventado
 * efectivamente no devuelve nada.
 */
test('El buscador filtra: un nombre inexistente no devuelve resultados', async ({ page }) => {
  const resultado = await buscarProfesional(page, 'Profesional Que No Existe XYZ');

  expect(resultado).toBe('sin-resultados');
  await expect(page.locator('.pro-card')).toHaveCount(0);
});

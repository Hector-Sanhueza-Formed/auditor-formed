/**
 * Genera data/agendas.json desde la API pública de formed.cl.
 *
 * Necesitamos el `id` de cada profesional porque la página de reserva vive en
 * /reserva/<id>, y ese id no aparece en el HTML del listado.
 *
 * `url_agendamiento` vacío = el profesional NO tiene reserva online
 * configurada. Esos ni siquiera se publican en /profesionales.
 *
 * Uso: npm run agendas
 */
const { request } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const API = 'https://formed.cl/api/public_data/profesionales?include=all';
const SALIDA = path.join(__dirname, '..', 'data', 'agendas.json');

const nombreCompleto = (p) =>
  [p.nombre, p.apellido_paterno, p.apellido_materno]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

(async () => {
  const ctx = await request.newContext();
  console.log(`Consultando ${API} …`);
  const res = await ctx.get(API);
  if (!res.ok()) throw new Error(`La API respondió ${res.status()}`);

  const cuerpo = await res.json();
  const lista = Array.isArray(cuerpo) ? cuerpo : cuerpo.data || [];
  await ctx.dispose();

  if (lista.length === 0) throw new Error('La API no devolvió profesionales');

  const agendas = lista
    .map((p) => ({
      id: p.id,
      nombre: nombreCompleto(p),
      especialidad: (p.especialidades || []).map((e) => e.nombre).join(', ') || '(sin especialidad)',
      tieneAgenda: Boolean(p.url_agendamiento),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  fs.writeFileSync(SALIDA, JSON.stringify(agendas, null, 2) + '\n');

  const sinAgenda = agendas.filter((a) => !a.tieneAgenda);
  console.log(`Profesionales en la API : ${agendas.length}`);
  console.log(`Con reserva online      : ${agendas.length - sinAgenda.length}`);
  console.log(`Escrito en              : ${path.relative(process.cwd(), SALIDA)}`);

  if (sinAgenda.length) {
    console.log(`\n⚠  ${sinAgenda.length} sin reserva online configurada:`);
    sinAgenda.forEach((a) => console.log(`   - [${a.id}] ${a.nombre}`));
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

/**
 * Cruza data/tratamientos.json (lo que ofrece la agenda por especialidad)
 * con data/profesionales.json (el catálogo publicado en el listado).
 *
 * Resultado:
 *  - A cada profesional del catálogo se le agrega `tratamientos`.
 *  - Se informan los desajustes en ambos sentidos.
 *
 * No navega: se puede reejecutar las veces que haga falta.
 *
 * Uso: npm run cruzar
 */
const fs = require('fs');
const path = require('path');

const DIR_DATOS = path.join(__dirname, '..', 'data');
const TRATAMIENTOS = path.join(DIR_DATOS, 'tratamientos.json');
const CATALOGO = path.join(DIR_DATOS, 'profesionales.json');

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Palabras del nombre, sin títulos ni signos sueltos. */
function tokens(nombre) {
  return normalizar(nombre)
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(' ')
    .filter((t) => t && !['dr', 'dra', 'ps', 'enf', 'mg', 'klga', 'klgo', 'nut', 'mat'].includes(t));
}

/**
 * ¿Son la misma persona?
 *
 * Los dos lados escriben el nombre distinto:
 *  - la agenda suele ser más completa  ("Camila Olivia Urzúa Abarca"
 *    frente a "Camila Urzúa Abarca" en el catálogo);
 *  - y a veces abrevia el apellido materno ("María Julia Puca C").
 *
 * Por eso no sirve comparar cadenas ni prefijos: se exige que todas las
 * palabras del nombre más corto aparezcan en el más largo, aceptando que una
 * inicial represente a una palabra completa.
 */
function coincide(nombreA, nombreB) {
  const a = tokens(nombreA);
  const b = tokens(nombreB);
  if (a.length < 2 || b.length < 2) return false;

  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  const usados = new Set();
  let aciertos = 0;

  for (const palabra of corto) {
    const posicion = largo.findIndex(
      (otra, i) =>
        !usados.has(i) &&
        (otra === palabra ||
          (palabra.length === 1 && otra.startsWith(palabra)) ||
          (otra.length === 1 && palabra.startsWith(otra))),
    );
    if (posicion >= 0) {
      usados.add(posicion);
      aciertos++;
    }
  }

  return aciertos === corto.length;
}

function cruzar() {
  const tratamientos = JSON.parse(fs.readFileSync(TRATAMIENTOS, 'utf8'));
  const catalogo = JSON.parse(fs.readFileSync(CATALOGO, 'utf8'));

  const porProfesional = new Map();
  const sinCatalogo = new Map();

  for (const fila of tratamientos) {
    for (const prof of fila.profesionales) {
      const enCatalogo = catalogo.find((c) => coincide(prof.nombre, c.nombre));
      const destino = enCatalogo ? porProfesional : sinCatalogo;
      const clave = enCatalogo ? enCatalogo.nombre : prof.nombre;
      const lista = destino.get(clave) ?? new Set();
      lista.add(fila.tratamiento);
      destino.set(clave, lista);
    }
  }

  const enriquecido = catalogo.map((c) => {
    const { tratamientos: _previo, ...resto } = c;
    return {
      ...resto,
      tratamientos: [...(porProfesional.get(c.nombre) ?? [])].sort((x, y) =>
        x.localeCompare(y, 'es'),
      ),
    };
  });
  fs.writeFileSync(CATALOGO, JSON.stringify(enriquecido, null, 2) + '\n');

  return { tratamientos, catalogo: enriquecido, sinCatalogo };
}

function informar({ tratamientos, catalogo, sinCatalogo }) {
  const vacios = tratamientos.filter((t) => t.totalProfesionales === 0);
  const sinTratamiento = catalogo.filter((c) => c.tratamientos.length === 0);

  console.log('──────── CRUCE AGENDA ↔ CATÁLOGO ────────');
  console.log(`Tratamientos                       : ${tratamientos.length}`);
  console.log(`  …sin ningún profesional          : ${vacios.length}`);
  console.log(`Profesionales del catálogo         : ${catalogo.length}`);
  console.log(`  …con al menos un tratamiento     : ${catalogo.length - sinTratamiento.length}`);
  console.log(`  …que no aparecen en ninguno      : ${sinTratamiento.length}`);
  console.log(`Nombres en la agenda sin catálogo  : ${sinCatalogo.size}`);

  if (vacios.length) {
    console.log('\n⚠ Tratamientos sin ningún profesional disponible:');
    vacios.forEach((v) => console.log(`   - ${v.tratamiento}`));
  }
  if (sinCatalogo.size) {
    console.log('\n⚠ En la agenda pero sin coincidencia en profesionales.json:');
    [...sinCatalogo.keys()]
      .sort((a, b) => a.localeCompare(b, 'es'))
      .forEach((n) => console.log(`   - ${n}  → ${[...sinCatalogo.get(n)].length} tratamiento(s)`));
  }
}

module.exports = { coincide, tokens, cruzar, informar };

if (require.main === module) {
  try {
    informar(cruzar());
    console.log(`\nActualizado: data/profesionales.json (campo "tratamientos")`);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
}

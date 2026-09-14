/**
 * globalSetup de Playwright: vacía screenshots/ antes de cada corrida.
 *
 * Así la carpeta refleja siempre los fallos de la ÚLTIMA auditoría y no
 * acumula imágenes de profesionales que ya se corrigieron o que ya no existen.
 */
const fs = require('fs');
const path = require('path');

const CARPETA = path.join(__dirname, '..', 'screenshots');

module.exports = async () => {
  if (!fs.existsSync(CARPETA)) {
    fs.mkdirSync(CARPETA, { recursive: true });
    return;
  }

  const imagenes = fs.readdirSync(CARPETA).filter((f) => f.endsWith('.png'));
  for (const imagen of imagenes) {
    fs.unlinkSync(path.join(CARPETA, imagen));
  }

  if (imagenes.length) {
    console.log(`Capturas de la corrida anterior eliminadas: ${imagenes.length}`);
  }
};

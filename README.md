# Auditor FORMEd

Auditoría automatizada del sitio **formed.cl** con Playwright + TypeScript.

## Módulos

| Módulo | Qué verifica | Archivo |
| ------ | ------------ | ------- |
| 1. Listado | Que cada profesional del catálogo aparezca al buscarlo | `tests/profesionales.spec.ts` |
| 2. Reserva online | Que cada profesional permita reservar hora | `tests/reserva-online.spec.ts` |

```bash
npm test                              # todo
npx playwright test profesionales     # solo módulo 1
npx playwright test reserva-online    # solo módulo 2
```

## Módulo 1 — Listado

Por cada profesional listado en `data/profesionales.json` (**217 en total**), el auditor:

1. Abre `https://formed.cl/profesionales?nombre=<nombre>`
2. Espera a que la búsqueda resuelva
3. Verifica que el profesional aparezca en los resultados
4. Si falla, guarda la captura en `screenshots/`

🟢 encontrado · 🔴 no encontrado (test rojo + captura + traza)

Incluye además un **control negativo**: confirma que un nombre inventado no
devuelve resultados. Sin él, si el buscador dejara de filtrar, todos los demás
tests pasarían en falso.

## Instalación

Solo la primera vez:

```bash
npm install
npx playwright install   # descarga los navegadores
```

## Comandos

Todos se ejecutan desde la carpeta `auditor-formed`.

### Ejecutar auditorías

| Comando | Qué hace |
| ------- | -------- |
| `npm test` | Los dos módulos completos |
| `npm run test:listado` | Solo módulo 1: que cada profesional aparezca (~1 min) |
| `npm run test:reserva` | Solo módulo 2: reserva online (lento, ~20 min) |

### Un solo profesional

Lo más útil para revisar un caso puntual sin esperar los 219. El texto busca
dentro del nombre del test, así que sirve un nombre parcial:

```bash
npx playwright test reserva-online -g "Manuel Cañumir"
npx playwright test profesionales -g "Manuel Cañumir"
```

Por id, útil cuando hay nombres repetidos:

```bash
npx playwright test reserva-online -g "[157]"
```

### Ver el navegador

| Comando | Qué hace |
| ------- | -------- |
| `npm run ver:reserva` | Módulo 2 con navegador visible, un test a la vez |
| `npm run ver:listado` | Módulo 1 con navegador visible |

Combinable con `-g` para un solo profesional:

```bash
npm run ver:reserva -- -g "Emilia Antonia"
```

Si el flujo va muy rápido para seguirlo, `LENTO=1` pone una pausa de 0,7 s
entre cada acción:

```bash
LENTO=1 npm run ver:reserva -- -g "Emilia Antonia"      # Git Bash
```

```powershell
$env:LENTO=1; npm run ver:reserva -- -g "Emilia Antonia"  # PowerShell
Remove-Item Env:LENTO                                    # para apagarlo
```

### Investigar un fallo

El modo UI de Playwright es lo mejor para entender por qué algo falla: línea de
tiempo con captura de cada paso, DOM inspeccionable y repetición del test sin
volver a escribir el comando.

```bash
npx playwright test reserva-online --ui -g "Emilia Antonia"
```

Para revisar una corrida que ya terminó, sin volver a golpear el sitio:

```bash
npm run report
```

### Regenerar los catálogos

```bash
npm run catalogo   # data/profesionales.json, desde el HTML del listado
npm run agendas    # data/agendas.json, desde la API pública
```

Revisa el `git diff` antes de aceptarlos: ahí se ve quién apareció, quién
desapareció y quién cambió de especialidad.

### Otros

```bash
npm run typecheck  # revisa los tipos sin ejecutar nada
```

## Velocidad y confiabilidad

El módulo 2 prueba hasta 4 sucursales por profesional, así que tarda. Se puede
acelerar con más navegadores en paralelo:

```bash
npm run test:reserva -- --workers=6
```

⚠️ **Cuidado con eso.** Con muchos workers el widget de agenda responde más
lento y aparecen rojos falsos por timeout. Para resultados en los que vayas a
confiar, usa 3 o 4. Para confirmar un caso puntual, `--workers=1`.

## Capturas: la carpeta no crece

`screenshots/` guarda **solo los tests en rojo**, y se vacía al inicio de cada
corrida ([scripts/limpiar-capturas.js](scripts/limpiar-capturas.js), enganchado
como `globalSetup`). O sea:

- Auditoría en verde → carpeta vacía
- 3 profesionales caídos → exactamente 3 imágenes

La carpeta es la **lista de problemas actuales**, no un archivo histórico. No
acumula capturas de profesionales que ya se corrigieron.

Si necesitas la evidencia completa de una corrida puntual (~45 MB, 217 imágenes):

```bash
CAPTURAS=todas npm test          # Git Bash
$env:CAPTURAS='todas'; npm test  # PowerShell
```

`test-results/` (capturas y trazas que genera Playwright al fallar) y
`playwright-report/` también se reescriben en cada corrida. Las tres carpetas
están en `.gitignore`.

## El catálogo

`data/profesionales.json` es la lista esperada. Se regenera desde el sitio con:

```bash
npm run catalogo
```

⚠️ **Es un snapshot, no una fuente de verdad independiente.** Se extrae de la
misma página que audita, así que sirve para detectar *cambios* —un profesional
que desaparece del listado, uno que cambia de especialidad— pero no para validar
que lo publicado hoy sea correcto. Regenéralo a propósito y **revisa el diff en
git** antes de aceptarlo: si alguien desapareció por error, regenerar el catálogo
borra la evidencia en vez de mostrarla.

## Estructura

```
auditor-formed/
├── data/profesionales.json      catálogo esperado (217 profesionales)
├── scripts/generar-catalogo.js  regenera el catálogo desde la web
├── tests/profesionales.spec.ts
├── screenshots/                 capturas de los fallos (se vacía por corrida)
├── playwright.config.ts
└── tsconfig.json
```

## Selectores del sitio

La página de profesionales expone filtros por query string
(`sucursal`, `especialidad`, `nombre`, `edadMin`, `sexo`, `etiqueta`) y renderiza
las 217 tarjetas sin paginación. Clases relevantes:

| Selector            | Contenido                          |
| ------------------- | ---------------------------------- |
| `.pro-card`         | tarjeta de un profesional          |
| `.pro-nombre-real`  | nombre                             |
| `.pro-prefijo`      | tratamiento (Dr., Ps., …)          |
| `.pro-cargo`        | cargo / especialidad               |
| `.pro-tag`          | etiquetas (especialidad, sucursal) |
| `.pro-info-txt`     | edad, dirección, formación         |

La página es Next.js y **re-renderiza tras hidratar**: leer el DOM apenas carga
devuelve resultados vacíos de forma intermitente. Por eso la espera vive dentro
del navegador (`page.waitForFunction`) en vez de contar tarjetas una sola vez.

## Módulo 2 — Reserva online

Recorre el flujo real de un paciente y se detiene antes de reservar:

```
/reserva/<id>  →  [elegir sucursal]   →  elegir atención  →  Continuar
               →  elegir día con cupo →  elegir hora      →  Continuar
               →  [Ingrese sus datos]  ←  AQUÍ SE DETIENE
```

**El wizard tiene 3 o 4 pasos según el profesional.** Quien atiende en varias
sucursales tiene un paso extra al principio para elegirla. Asumir 3 pasos hace
que se seleccione la *sucursal* creyendo que es la atención, y que el calendario
nunca aparezca: eso producía rojos falsos en masa.

Por lo mismo el auditor **prueba hasta 4 sucursales** antes de dar a alguien por
caído: puede haber cupo en una y no en otra.

**Nunca completa el formulario.** Llegar al paso 3 no crea ninguna reserva:
sin datos del paciente no hay nada que enviar.

La agenda es un iframe de `agendamiento.reservo.cl` embebido en formed.cl.
No se usa la API de Reservo ni credenciales: es el mismo widget público que ve
cualquier paciente.

### Diagnósticos

Cuando un profesional falla, el mensaje dice **en qué punto** se cortó:

| Estado | Significado |
| ------ | ----------- |
| `sin-agenda` | no tiene `url_agendamiento` en la API |
| `sin-iframe` | la página de reserva no cargó el widget |
| `sin-atenciones` | el widget cargó pero no ofrece atenciones |
| `sin-dias` | ningún día con cupo en los próximos 3 meses |
| `sin-horas` | hay días con cupo, pero ninguno ofrece horas |
| `no-avanza` | con día y hora elegidos, el wizard no llegó al paso de datos |

### El catálogo de agendas

`data/agendas.json` sale de la API pública de formed.cl, que es la única
fuente del `id` usado en `/reserva/<id>` (no aparece en el HTML del listado):

```bash
npm run agendas
```

### Cuatro trampas del widget

- **El calendario carga la disponibilidad por red.** Leerlo apenas cambia de
  mes devuelve días "libres" que en realidad no lo son. Por eso
  `contarDiasEstable()` espera a que la cuenta se repita en dos lecturas.
- **Todo click lleva timeout explícito.** Sin él, un click que espera
  "actionability" consume el timeout entero del test (2 min) en vez de fallar
  con un diagnóstico útil.
- **El id del paso final cambia.** Es `step-Ingresesusdatos2` con wizard de 3
  pasos y `...3` con 4, así que se busca por prefijo.
- **Hay que pausar tras elegir la hora.** Pulsar Continuar de inmediato deja el
  wizard sin avanzar, y el síntoma parece un profesional caído cuando en
  realidad su agenda funciona.

## Siguientes pasos

- Validar especialidad, sucursal y rango etario contra el catálogo esperado
- Detectar profesionales publicados que no estén en el catálogo (y viceversa)
- Revisar el flujo de reserva y la disponibilidad de horas
- Historial de corridas y dashboard

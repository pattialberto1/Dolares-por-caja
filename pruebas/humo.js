'use strict';

/**
 * Prueba de humo: levanta el servidor con la lectura simulada, crea una cajera,
 * sube dos fotos y comprueba que la búsqueda por serial devuelve la cajera.
 * Uso:  node pruebas/humo.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dolares-prueba-'));
const PUERTO = 3999;
const BASE = `http://127.0.0.1:${PUERTO}`;

let fallos = 0;
function comprobar(descripcion, condicion, detalle) {
  if (condicion) console.log(`  ✓ ${descripcion}`);
  else { fallos++; console.log(`  ✗ ${descripcion}${detalle ? ' → ' + JSON.stringify(detalle) : ''}`); }
}

let cookie = '';
async function pedir(ruta, opciones = {}) {
  const r = await fetch(BASE + ruta, { ...opciones, headers: { ...(opciones.headers || {}), cookie } });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const tipo = r.headers.get('content-type') || '';
  return { estado: r.status, datos: tipo.includes('json') ? await r.json() : await r.text() };
}
const pedirJson = (ruta, metodo, cuerpo) =>
  pedir(ruta, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

async function fotoFalsa(texto) {
  return sharp({
    create: { width: 600, height: 260, channels: 3, background: { r: 200, g: 220, b: 200 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="600" height="260"><text x="30" y="140" font-size="40" fill="#111">${texto}</text></svg>`
        ),
      },
    ])
    .jpeg()
    .toBuffer();
}

async function subir(buffer, cajeraId, nota) {
  const form = new FormData();
  form.append('foto', new Blob([buffer], { type: 'image/jpeg' }), 'billete.jpg');
  form.append('cajera_id', String(cajeraId));
  form.append('nota', nota);
  return pedir('/api/capturas', { method: 'POST', body: form });
}

(async () => {
  const servidor = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DIR_DATOS: DIR, PUERTO: String(PUERTO), SIMULAR_LECTURA: '1', PIN_ADMIN: '9999' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  await new Promise((resolve, reject) => {
    servidor.stdout.on('data', (d) => { if (String(d).includes('http://')) resolve(); });
    setTimeout(() => reject(new Error('El servidor no arrancó a tiempo.')), 15000);
  });

  try {
    console.log('\nSesión');
    comprobar('sin sesión, /api/yo responde 401', (await pedir('/api/yo')).estado === 401);
    comprobar('PIN incorrecto es rechazado', (await pedirJson('/api/entrar', 'POST', { nombre: 'admin', pin: '0000' })).estado === 401);
    const entrada = await pedirJson('/api/entrar', 'POST', { nombre: 'admin', pin: '9999' });
    comprobar('admin entra con su PIN', entrada.estado === 200, entrada.datos);

    console.log('\nCajeras');
    const cajera = await pedirJson('/api/cajeras', 'POST', { nombre: 'María' });
    const otra = await pedirJson('/api/cajeras', 'POST', { nombre: 'Yoselin' });
    comprobar('se crean dos cajeras', cajera.estado === 200 && otra.estado === 200, [cajera.datos, otra.datos]);
    comprobar('no se repite el nombre', (await pedirJson('/api/cajeras', 'POST', { nombre: 'María' })).estado === 400);

    console.log('\nSubida y lectura de fotos');
    const fotoA = await fotoFalsa('billete uno');
    const fotoB = await fotoFalsa('billete dos');
    const subidaA = await subir(fotoA, cajera.datos.cajera.id, 'venta de la tarde');
    comprobar('la foto se procesa y devuelve billetes', subidaA.datos.captura?.billetes?.length === 1, subidaA.datos);
    comprobar('el billete queda a nombre de la cajera', subidaA.datos.captura.billetes[0].cajera === 'María');

    const repetida = await subir(fotoA, otra.datos.cajera.id, 'la misma foto otra vez');
    comprobar('la misma foto no se registra dos veces', repetida.datos.repetida === true, repetida.datos);

    const subidaB = await subir(fotoB, otra.datos.cajera.id, '');
    comprobar('una segunda foto sí entra', subidaB.datos.repetida === false && subidaB.datos.captura.billetes.length === 1);

    console.log('\nBúsqueda');
    const serial = subidaA.datos.captura.billetes[0].serial_norm;
    const exacta = await pedir('/api/billetes/buscar?q=' + serial);
    comprobar('el serial completo encuentra el billete', exacta.datos.exactos?.length === 1, exacta.datos);
    comprobar('la búsqueda dice de qué cajera es', exacta.datos.exactos[0].cajera === 'María');

    const parcial = await pedir('/api/billetes/buscar?q=' + serial.slice(-5));
    comprobar('un pedazo del serial también encuentra', parcial.datos.total >= 1, parcial.datos);
    comprobar('con menos de 3 caracteres avisa', (await pedir('/api/billetes/buscar?q=ab')).estado === 400);
    comprobar('un serial inexistente no devuelve nada', (await pedir('/api/billetes/buscar?q=ZZ99999999Z')).datos.total === 0);

    console.log('\nCorrección manual');
    const billeteId = subidaB.datos.captura.billetes[0].id;
    const corregido = await pedirJson('/api/billetes/' + billeteId, 'PATCH', { serial: 'PL 11112222 C', denominacion: 100 });
    comprobar('se corrige el serial a mano', corregido.datos.billete?.serial_norm === 'PL11112222C', corregido.datos);
    comprobar('el corregido queda marcado como verificado', corregido.datos.billete.verificado === 1);
    comprobar('se busca por el serial corregido', (await pedir('/api/billetes/buscar?q=PL11112222C')).datos.exactos.length === 1);

    console.log('\nSeriales repetidos');
    const captura3 = await subir(await fotoFalsa('tercera'), cajera.datos.cajera.id, '');
    await pedirJson('/api/billetes/' + captura3.datos.captura.billetes[0].id, 'PATCH', { serial: 'PL 11112222 C', denominacion: 100 });
    const repetidos = await pedir('/api/billetes/repetidos');
    comprobar('detecta el serial que aparece dos veces', repetidos.datos.repetidos.some((r) => r.serial_norm === 'PL11112222C'), repetidos.datos);

    console.log('\nBorrado y reproceso');
    const idRepetido = captura3.datos.captura.billetes[0].id;
    comprobar('se borra un billete al que otro apunta como duplicado',
      (await pedir('/api/billetes/' + idRepetido, { method: 'DELETE' })).estado === 200);
    const reproceso = await pedir(`/api/capturas/${subidaA.datos.captura.id}/reprocesar`, { method: 'POST' });
    comprobar('se vuelve a leer una captura', reproceso.datos.captura?.billetes?.length === 1, reproceso.datos);

    console.log('\nReportes');
    const resumen = await pedir('/api/reportes/resumen');
    comprobar('el resumen suma por cajera', resumen.datos.por_cajera?.length === 2, resumen.datos);
    comprobar('el total de billetes es 2', resumen.datos.totales.billetes === 2, resumen.datos.totales);
    const csv = await pedir('/api/reportes/exportar.csv');
    comprobar('el CSV trae cabecera y filas', csv.datos.includes('serial') && csv.datos.split('\n').length >= 3);

    console.log('\nPermisos');
    await pedirJson('/api/usuarios', 'POST', { nombre: 'maria', pin: '4321', rol: 'operador' });
    await pedir('/api/salir', { method: 'POST' });
    await pedirJson('/api/entrar', 'POST', { nombre: 'maria', pin: '4321' });
    comprobar('un operador no puede crear cajeras', (await pedirJson('/api/cajeras', 'POST', { nombre: 'X' })).estado === 403);
    comprobar('un operador sí puede buscar', (await pedir('/api/billetes/buscar?q=PL11112222C')).estado === 200);
    comprobar('un operador no ve la lista de usuarios', (await pedir('/api/usuarios')).estado === 403);

    console.log(fallos === 0 ? '\n✅ Todas las comprobaciones pasaron.\n' : `\n❌ ${fallos} comprobación(es) fallaron.\n`);
  } finally {
    servidor.kill();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  process.exit(fallos === 0 ? 0 : 1);
})();

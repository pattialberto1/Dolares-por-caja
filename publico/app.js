'use strict';

/* ------------------------------------------------------------------ utiles */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dinero = (n) => '$' + Number(n || 0).toLocaleString('es-VE');
const fecha = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }) : '');

let temporizadorAviso;
function avisar(texto, ms = 3000) {
  const el = $('#aviso');
  el.textContent = texto;
  el.classList.remove('oculto');
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => el.classList.add('oculto'), ms);
}

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, { credentials: 'same-origin', ...opciones });
  const datos = r.headers.get('content-type')?.includes('json') ? await r.json() : {};
  if (r.status === 401) { mostrarEntrar(); throw new Error('Sesión expirada.'); }
  if (!r.ok) throw new Error(datos.error || 'No se pudo completar la operación.');
  return datos;
}

const apiJson = (ruta, metodo, cuerpo) =>
  api(ruta, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

/* --------------------------------------------------------------- estado */
let yo = null;
let cajeras = [];

/* ----------------------------------------------- redimensionar en el móvil */
// Encoger antes de subir ahorra datos y hace la subida viable con señal mala.
function encoger(archivo, maxLado = 1800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(img.width * escala);
      lienzo.height = Math.round(img.height * escala);
      lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
      lienzo.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo procesar la imagen.'))), 'image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    img.src = URL.createObjectURL(archivo);
  });
}

/* ------------------------------------------------------ cola sin conexión */
// Las fotos que no se pudieron enviar quedan guardadas en el teléfono.
const COLA_DB = 'dolares-cola';
function abrirCola() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(COLA_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pendientes', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function conCola(modo, fn) {
  const db = await abrirCola();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendientes', modo);
    const pedido = fn(tx.objectStore('pendientes'));
    pedido.onsuccess = () => resolve(pedido.result);
    pedido.onerror = () => reject(pedido.error);
  });
}
const encolar = (item) => conCola('readwrite', (s) => s.add(item));
const leerCola = () => conCola('readonly', (s) => s.getAll());
const sacarDeCola = (id) => conCola('readwrite', (s) => s.delete(id));

async function pintarCola() {
  const pendientes = await leerCola();
  $('#cola').classList.toggle('oculto', pendientes.length === 0);
  $('#lista-cola').innerHTML = pendientes
    .map((p) => `<li><span class="crece">${esc(p.cajera_nombre)} · ${fecha(p.creado)}</span><span class="chip alerta">pendiente</span></li>`)
    .join('');
}

async function vaciarCola({ silencioso = false } = {}) {
  const pendientes = await leerCola();
  if (!pendientes.length) return;
  let enviadas = 0;
  for (const p of pendientes) {
    try {
      const captura = await subirFoto(p.blob, p.cajera_id, p.nota);
      await sacarDeCola(p.id);
      enviadas++;
      pintarCaptura(captura, true);
    } catch {
      break; // sigue sin conexión: se reintenta después
    }
  }
  await pintarCola();
  if (enviadas && !silencioso) avisar(`Se enviaron ${enviadas} foto(s) pendientes.`);
}

/* --------------------------------------------------------------- registrar */
async function subirFoto(blob, cajeraId, nota) {
  const form = new FormData();
  form.append('foto', blob, 'billete.jpg');
  form.append('cajera_id', cajeraId);
  form.append('nota', nota || '');
  const datos = await api('/api/capturas', { method: 'POST', body: form });
  if (datos.repetida) avisar('Esa foto ya estaba registrada; no se duplicó.');
  return datos.captura;
}

async function manejarArchivos(archivos) {
  const cajeraId = $('#sel-cajera').value;
  const cajeraNombre = $('#sel-cajera').selectedOptions[0]?.textContent || '';
  const nota = $('#nota').value;
  if (!cajeraId) return avisar('Primero elige la cajera.');

  $('#btn-foto').disabled = true;
  for (const archivo of archivos) {
    const marcador = pintarCargando(cajeraNombre);
    try {
      const blob = await encoger(archivo);
      try {
        const captura = await subirFoto(blob, cajeraId, nota);
        marcador.remove();
        pintarCaptura(captura, true);
      } catch (err) {
        if (!navigator.onLine || /fetch|network|failed/i.test(err.message)) {
          await encolar({ blob, cajera_id: cajeraId, cajera_nombre: cajeraNombre, nota, creado: new Date().toISOString() });
          marcador.remove();
          await pintarCola();
          avisar('Sin conexión: la foto quedó guardada y se enviará sola.');
        } else {
          marcador.innerHTML = `<p class="error">${esc(err.message)}</p>`;
        }
      }
    } catch (err) {
      marcador.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }
  $('#btn-foto').disabled = false;
  $('#nota').value = '';
  $('#archivo').value = '';
}

function pintarCargando(cajeraNombre) {
  const div = document.createElement('div');
  div.className = 'tarjeta';
  div.innerHTML = `<p class="cargando">Leyendo los billetes de ${esc(cajeraNombre)}…</p>`;
  $('#resultados').prepend(div);
  return div;
}

function chipConfianza(b) {
  if (b.verificado) return '<span class="chip">verificado</span>';
  if (b.confianza === 'alta') return '<span class="chip">leído ok</span>';
  return `<span class="chip alerta">revisar (${esc(b.confianza || 'sin leer')})</span>`;
}

function filaBillete(b, conFoto = false) {
  const repetido = b.duplicado_de || b.repeticiones > 0;
  return `
    <div class="billete" data-billete="${b.id}">
      ${conFoto && b.miniatura ? `<img src="/fotos/${esc(b.miniatura)}" alt="">` : ''}
      <div class="datos">
        <div class="serial">${esc(b.serial || '(sin leer)')}</div>
        <div class="tenue pequeno">
          ${b.denominacion ? dinero(b.denominacion) : 'denominación ?'} ·
          ${esc(b.cajera)} · ${fecha(b.creado_en)}
          ${b.serie ? ' · serie ' + esc(b.serie) : ''}
        </div>
        ${b.observaciones ? `<div class="tenue pequeno">${esc(b.observaciones)}</div>` : ''}
        <div style="margin-top:.3rem">
          ${chipConfianza(b)}
          ${repetido ? '<span class="chip mal">serial repetido</span>' : ''}
        </div>
      </div>
      <button class="secundario editar" data-id="${b.id}">✏️</button>
    </div>`;
}

function pintarCaptura(captura, alPrincipio = false) {
  const div = document.createElement('div');
  div.className = 'tarjeta';
  const total = captura.billetes.reduce((s, b) => s + (b.denominacion || 0), 0);
  div.innerHTML = `
    <div class="fila" style="align-items:center">
      <strong class="crece">${esc(captura.cajera)} · ${captura.billetes.length} billete(s) · ${dinero(total)}</strong>
      <button class="secundario reprocesar" data-id="${captura.id}" style="flex:0">Volver a leer</button>
    </div>
    ${captura.estado === 'error' ? `<p class="error">No se pudo leer: ${esc(captura.error || '')}</p>` : ''}
    ${captura.nota ? `<p class="tenue pequeno">${esc(captura.nota)}</p>` : ''}
    <div class="contenedor-billetes" style="margin-top:.6rem">${captura.billetes.map((b) => filaBillete(b)).join('') || '<p class="tenue">No se detectó ningún billete en la foto.</p>'}</div>
    <div class="fila" style="margin-top:.5rem">
      <button class="secundario agregar" data-captura="${captura.id}" data-cajera="${captura.cajera_id}">+ Añadir billete a mano</button>
      <a href="/fotos/${esc(captura.archivo)}" target="_blank" class="tenue pequeno" style="flex:0;white-space:nowrap">Ver foto</a>
    </div>`;
  if (alPrincipio) $('#resultados').prepend(div);
  return div;
}

/* ------------------------------------------------- edición de un billete */
async function editarBillete(id, contenedor) {
  const actual = contenedor.querySelector('.serial').textContent.trim();
  const serial = prompt('Serial correcto del billete:', actual === '(sin leer)' ? '' : actual);
  if (serial === null) return;
  const denominacion = prompt('Denominación (1, 5, 10, 20, 50, 100):', '') || '';
  try {
    const { billete } = await apiJson(`/api/billetes/${id}`, 'PATCH', {
      serial,
      ...(denominacion ? { denominacion: Number(denominacion) } : {}),
    });
    contenedor.outerHTML = contenedor.classList.contains('resultado')
      ? tarjetaResultado(billete)
      : filaBillete(billete);
    avisar('Billete corregido.');
  } catch (err) { avisar(err.message); }
}

function tarjetaResultado(b) {
  const repetido = b.repeticiones > 0 || b.duplicado_de;
  return `
    <div class="resultado">
      ${b.miniatura ? `<a href="/fotos/${esc(b.archivo)}" target="_blank"><img src="/fotos/${esc(b.miniatura)}" alt="foto del billete"></a>` : ''}
      <div class="datos">
        <div class="tenue pequeno">Recibido por</div>
        <div class="cajera-grande">${esc(b.cajera)}</div>
        <div class="serial">${esc(b.serial || '(sin leer)')}</div>
        <div class="tenue pequeno">
          ${fecha(b.creado_en)}
          ${b.denominacion ? ' · ' + dinero(b.denominacion) : ''}
          ${b.registrado_por ? ' · lo subió ' + esc(b.registrado_por) : ''}
        </div>
        ${b.nota ? `<div class="tenue pequeno">Nota: ${esc(b.nota)}</div>` : ''}
        <div style="margin-top:.4rem">
          ${chipConfianza(b)}
          ${repetido ? '<span class="chip mal">este serial aparece más de una vez</span>' : ''}
        </div>
      </div>
      <button class="secundario editar" data-id="${b.id}">✏️</button>
    </div>`;
}

/* ------------------------------------------------------------------ buscar */
async function buscar() {
  const q = $('#q').value.trim();
  if (q.length < 3) return avisar('Escribe al menos 3 caracteres.');
  $('#res-busqueda').innerHTML = '<div class="tarjeta"><p class="cargando">Buscando…</p></div>';
  try {
    const r = await api('/api/billetes/buscar?q=' + encodeURIComponent(q));
    if (!r.total) {
      $('#res-busqueda').innerHTML = '<div class="tarjeta"><p>Ese serial no aparece en el registro.</p></div>';
      return;
    }
    const bloque = (titulo, lista) =>
      lista.length
        ? `<div class="tarjeta"><h3>${titulo}</h3>${lista.map(tarjetaResultado).join('')}</div>`
        : '';
    $('#res-busqueda').innerHTML =
      bloque(r.exactos.length === 1 ? 'Este billete es de:' : `Coincidencia exacta (${r.exactos.length})`, r.exactos) +
      bloque(`Seriales parecidos (${r.parciales.length})`, r.parciales);
  } catch (err) {
    $('#res-busqueda').innerHTML = `<div class="tarjeta"><p class="error">${esc(err.message)}</p></div>`;
  }
}

/* --------------------------------------------------------------- historial */
async function cargarHistorial() {
  $('#lista-historial').innerHTML = '<div class="tarjeta"><p class="cargando">Cargando…</p></div>';
  const { capturas } = await api('/api/capturas?limite=50');
  $('#lista-historial').innerHTML = capturas.length
    ? `<div class="tarjeta">${capturas
        .map(
          (c) => `<div class="billete" data-abrir="${c.id}">
            ${c.miniatura ? `<img src="/fotos/${esc(c.miniatura)}" alt="">` : ''}
            <div class="datos">
              <strong>${esc(c.cajera)}</strong> · ${c.n_billetes} billete(s) · ${dinero(c.monto)}
              <div class="tenue pequeno">${fecha(c.recibida_en)}${c.nota ? ' · ' + esc(c.nota) : ''}</div>
              ${c.estado !== 'procesada' ? `<span class="chip ${c.estado === 'error' ? 'mal' : 'alerta'}">${esc(c.estado)}</span>` : ''}
            </div>
          </div>`
        )
        .join('')}</div>`
    : '<div class="tarjeta"><p class="tenue">Todavía no hay fotos registradas.</p></div>';
}

/* ---------------------------------------------------------------- reportes */
async function cargarReporte() {
  const params = new URLSearchParams();
  if ($('#desde').value) params.set('desde', $('#desde').value);
  if ($('#hasta').value) params.set('hasta', $('#hasta').value);
  const r = await api('/api/reportes/resumen?' + params);

  $('#res-reporte').innerHTML = `
    <div class="tarjeta">
      <h3>Total del período</h3>
      <p style="font-size:1.6rem;margin:.2rem 0"><strong>${dinero(r.totales.monto)}</strong>
        <span class="tenue" style="font-size:1rem">· ${r.totales.billetes} billetes</span></p>
      <table>
        <tr><th>Cajera</th><th class="num">Billetes</th><th class="num">Monto</th><th class="num">Por revisar</th></tr>
        ${r.por_cajera
          .map(
            (c) => `<tr><td>${esc(c.nombre)}</td><td class="num">${c.billetes}</td>
              <td class="num">${dinero(c.monto)}</td><td class="num">${c.por_revisar || 0}</td></tr>`
          )
          .join('')}
      </table>
      <p class="tenue pequeno" style="margin-top:.8rem">
        ${r.gasto.fotos} fotos procesadas · costo estimado de la API: ${'$' + Number(r.gasto.costo_usd).toFixed(2)}
      </p>
    </div>
    <div class="tarjeta">
      <h3>Por día</h3>
      <table>
        <tr><th>Día</th><th class="num">Billetes</th><th class="num">Monto</th></tr>
        ${r.por_dia.map((d) => `<tr><td>${esc(d.dia)}</td><td class="num">${d.billetes}</td><td class="num">${dinero(d.monto)}</td></tr>`).join('')}
      </table>
    </div>`;

  const { repetidos } = await api('/api/billetes/repetidos');
  $('#res-repetidos').innerHTML = repetidos.length
    ? `<table><tr><th>Serial</th><th class="num">Veces</th><th>Cajeras</th></tr>
        ${repetidos
          .map(
            (x) => `<tr><td><a href="#" class="ver-serial" data-serial="${esc(x.serial_norm)}">${esc(x.serial_norm)}</a></td>
              <td class="num">${x.veces}</td><td>${esc(x.cajeras)}</td></tr>`
          )
          .join('')}</table>`
    : '<p class="tenue">Ningún serial se ha repetido. 👍</p>';
}

/* ---------------------------------------------------------------- ajustes */
async function cargarAjustes() {
  const { cajeras: todas } = await api('/api/cajeras?todas=1');
  $('#lista-cajeras').innerHTML = todas
    .map(
      (c) => `<div class="item"><span class="crece">${esc(c.nombre)} <span class="tenue pequeno">· ${c.n_billetes} billetes</span></span>
        <button class="secundario alternar-cajera" data-id="${c.id}" data-activa="${c.activa}">${c.activa ? 'Desactivar' : 'Activar'}</button></div>`
    )
    .join('');

  if (yo.rol === 'admin') {
    const { usuarios } = await api('/api/usuarios');
    $('#lista-usuarios').innerHTML = usuarios
      .map(
        (u) => `<div class="item"><span class="crece">${esc(u.nombre)} <span class="chip">${esc(u.rol)}</span></span>
          <button class="secundario reset-pin" data-id="${u.id}">Cambiar PIN</button></div>`
      )
      .join('');
  }
}

/* -------------------------------------------------------------- navegación */
function mostrarVista(nombre) {
  $$('.vista').forEach((v) => v.classList.add('oculto'));
  $('#vista-' + nombre).classList.remove('oculto');
  $$('#pestanas button').forEach((b) => b.classList.toggle('activa', b.dataset.vista === nombre));
  if (nombre === 'historial') cargarHistorial().catch((e) => avisar(e.message));
  if (nombre === 'reportes') cargarReporte().catch((e) => avisar(e.message));
  if (nombre === 'ajustes') cargarAjustes().catch((e) => avisar(e.message));
}

function mostrarEntrar() {
  $('#app').classList.add('oculto');
  $('#pantalla-entrar').classList.remove('oculto');
}

async function cargarCajeras() {
  const r = await api('/api/cajeras');
  cajeras = r.cajeras;
  $('#sel-cajera').innerHTML = cajeras.length
    ? cajeras.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')
    : '<option value="">— añade cajeras en Ajustes —</option>';
  if (yo?.cajera_id) $('#sel-cajera').value = yo.cajera_id;
}

async function iniciar() {
  try {
    const r = await api('/api/yo');
    yo = r.usuario;
  } catch { return mostrarEntrar(); }

  $('#pantalla-entrar').classList.add('oculto');
  $('#app').classList.remove('oculto');
  $('#quien').textContent = yo.nombre;
  $$('.solo-admin').forEach((el) => el.classList.toggle('oculto', yo.rol !== 'admin'));

  const hoy = new Date().toISOString().slice(0, 10);
  $('#hasta').value = hoy;
  $('#desde').value = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

  await cargarCajeras();
  await pintarCola();
  vaciarCola({ silencioso: true });
  mostrarVista('registrar');
}

/* ---------------------------------------------------------------- eventos */
$('#form-entrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const datos = Object.fromEntries(new FormData(e.target));
  try {
    await apiJson('/api/entrar', 'POST', datos);
    $('#error-entrar').textContent = '';
    iniciar();
  } catch (err) { $('#error-entrar').textContent = err.message; }
});

$('#btn-salir').addEventListener('click', async () => { await api('/api/salir', { method: 'POST' }); location.reload(); });
$('#pestanas').addEventListener('click', (e) => { if (e.target.dataset.vista) mostrarVista(e.target.dataset.vista); });

$('#btn-foto').addEventListener('click', () => $('#archivo').click());
$('#archivo').addEventListener('change', (e) => manejarArchivos([...e.target.files]));
$('#btn-reintentar').addEventListener('click', () => vaciarCola());

$('#btn-buscar').addEventListener('click', buscar);
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') buscar(); });

$('#btn-reporte').addEventListener('click', () => cargarReporte().catch((e) => avisar(e.message)));
$('#btn-csv').addEventListener('click', () => {
  const p = new URLSearchParams({ desde: $('#desde').value, hasta: $('#hasta').value });
  location.href = '/api/reportes/exportar.csv?' + p;
});

document.addEventListener('click', async (e) => {
  const editar = e.target.closest('.editar');
  if (editar) return editarBillete(editar.dataset.id, editar.closest('.billete, .resultado'));

  const reprocesar = e.target.closest('.reprocesar');
  if (reprocesar) {
    reprocesar.disabled = true;
    try {
      const { captura } = await api(`/api/capturas/${reprocesar.dataset.id}/reprocesar`, { method: 'POST' });
      reprocesar.closest('.tarjeta').replaceWith(pintarCaptura(captura));
    } catch (err) { avisar(err.message); reprocesar.disabled = false; }
    return;
  }

  const agregar = e.target.closest('.agregar');
  if (agregar) {
    const serial = prompt('Serial del billete:');
    if (!serial) return;
    const denominacion = prompt('Denominación:', '') || '';
    try {
      const { billete } = await apiJson('/api/billetes', 'POST', {
        captura_id: agregar.dataset.captura,
        cajera_id: agregar.dataset.cajera,
        serial,
        ...(denominacion ? { denominacion: Number(denominacion) } : {}),
      });
      agregar.closest('.tarjeta').querySelector('.contenedor-billetes').insertAdjacentHTML('beforeend', filaBillete(billete));
    } catch (err) { avisar(err.message); }
    return;
  }

  const abrir = e.target.closest('[data-abrir]');
  if (abrir) {
    const { captura } = await api('/api/capturas/' + abrir.dataset.abrir);
    mostrarVista('registrar');
    pintarCaptura(captura, true);
    return;
  }

  const verSerial = e.target.closest('.ver-serial');
  if (verSerial) {
    e.preventDefault();
    mostrarVista('buscar');
    $('#q').value = verSerial.dataset.serial;
    buscar();
    return;
  }

  const alternar = e.target.closest('.alternar-cajera');
  if (alternar) {
    await apiJson('/api/cajeras/' + alternar.dataset.id, 'PATCH', { activa: alternar.dataset.activa === '1' ? 0 : 1 });
    await cargarAjustes(); await cargarCajeras();
    return;
  }

  const resetear = e.target.closest('.reset-pin');
  if (resetear) {
    const pin = prompt('PIN nuevo (mínimo 4 dígitos):');
    if (!pin) return;
    try { await apiJson('/api/usuarios/' + resetear.dataset.id, 'PATCH', { pin }); avisar('PIN actualizado.'); }
    catch (err) { avisar(err.message); }
  }
});

$('#btn-cajera').addEventListener('click', async () => {
  const nombre = $('#nueva-cajera').value.trim();
  if (!nombre) return;
  try {
    await apiJson('/api/cajeras', 'POST', { nombre });
    $('#nueva-cajera').value = '';
    await cargarAjustes(); await cargarCajeras();
    avisar('Cajera añadida.');
  } catch (err) { avisar(err.message); }
});

$('#btn-usuario').addEventListener('click', async () => {
  try {
    await apiJson('/api/usuarios', 'POST', {
      nombre: $('#nuevo-usuario').value.trim(),
      pin: $('#nuevo-pin').value,
      rol: $('#nuevo-rol').value,
    });
    $('#nuevo-usuario').value = ''; $('#nuevo-pin').value = '';
    await cargarAjustes();
    avisar('Usuario creado.');
  } catch (err) { avisar(err.message); }
});

$('#btn-mi-pin').addEventListener('click', async () => {
  const pin = $('#mi-pin').value;
  if (pin.length < 4) return avisar('El PIN debe tener al menos 4 dígitos.');
  try { await apiJson('/api/usuarios/' + yo.id, 'PATCH', { pin }); $('#mi-pin').value = ''; avisar('PIN actualizado.'); }
  catch (err) { avisar(err.message); }
});

function pintarRed() {
  const chip = $('#estado-red');
  chip.textContent = 'sin conexión';
  chip.className = 'chip alerta';
  chip.hidden = navigator.onLine;
}
window.addEventListener('online', () => { pintarRed(); vaciarCola(); });
window.addEventListener('offline', pintarRed);
pintarRed();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
iniciar();

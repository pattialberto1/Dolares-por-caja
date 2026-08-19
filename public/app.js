'use strict';

/* ------------------------------------------------------------------ utiles */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dinero = (n) => '$' + Number(n || 0).toLocaleString('es-VE');
// Postgres entrega las fechas ya en ISO 8601 con zona horaria.
const fecha = (s) => {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' });
};

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
function encoger(archivo, maxLado = 1800, calidad = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(img.width * escala);
      lienzo.height = Math.round(img.height * escala);
      lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
      lienzo.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo procesar la imagen.'))), 'image/jpeg', calidad);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Este navegador no pudo abrir esa imagen. Si viene de un iPhone en formato HEIC, compártela o guárdala como JPG.'));
    };
    img.src = URL.createObjectURL(archivo);
  });
}

// La miniatura se genera aquí y no en el servidor: así las listas y las
// búsquedas cargan con muy pocos datos, algo que se agradece en el celular.
async function prepararFoto(archivo) {
  const [grande, mini] = await Promise.all([encoger(archivo, 1800), encoger(archivo, 360, 0.7)]);
  return { grande, mini };
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
      const captura = await subirFoto({ grande: p.blob, mini: p.mini }, p.cajera_id, p.nota);
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
async function subirFoto({ grande, mini }, cajeraId, nota) {
  const form = new FormData();
  form.append('foto', grande, 'billete.jpg');
  if (mini) form.append('mini', mini, 'billete_mini.jpg');
  form.append('cajera_id', cajeraId);
  form.append('nota', nota || '');
  const datos = await api('/api/capturas', { method: 'POST', body: form });
  if (datos.repetida) avisar('Esa foto ya estaba registrada; no se duplicó.');
  return datos.captura;
}

// Lo registrado desde que se abrió la app, solo para no perder la cuenta:
// el registro de verdad está en Historial y Reportes.
const sesion = { fotos: 0, billetes: 0, monto: 0 };

function pintarResumenSesion() {
  const hay = sesion.fotos > 0;
  $('#cabecera-resultados').hidden = !hay;
  if (!hay) return;
  $('#resumen-sesion').textContent =
    `${sesion.fotos} foto${sesion.fotos === 1 ? '' : 's'} · ${sesion.billetes} billete${sesion.billetes === 1 ? '' : 's'} · ${dinero(sesion.monto)}`;
}

function limpiarResultados() {
  $('#resultados').innerHTML = '';
  sesion.fotos = sesion.billetes = sesion.monto = 0;
  pintarResumenSesion();
}

async function manejarArchivos(seleccionados) {
  const archivos = [...seleccionados].filter((a) => a.type.startsWith('image/'));
  if (archivos.length === 0) return avisar('Elige imágenes: eso no parece una foto.');
  if (archivos.length < seleccionados.length) {
    avisar(`Se ignoraron ${seleccionados.length - archivos.length} archivo(s) que no eran imágenes.`);
  }

  const cajeraId = $('#sel-cajera').value;
  const cajeraNombre = $('#sel-cajera').selectedOptions[0]?.textContent || '';
  const nota = $('#nota').value;
  if (!cajeraId) return avisar('Primero elige la cajera.');

  // Cada tanda parte de cero: si no, la pantalla crece sin fin foto tras foto.
  $('#resultados').innerHTML = '';
  sesion.fotos = sesion.billetes = sesion.monto = 0;

  const botones = [$('#btn-foto'), $('#btn-galeria')];
  botones.forEach((b) => (b.disabled = true));
  for (const archivo of archivos) {
    const marcador = pintarCargando(cajeraNombre);
    try {
      const imagenes = await prepararFoto(archivo);
      try {
        const captura = await subirFoto(imagenes, cajeraId, nota);
        marcador.remove();
        pintarCaptura(captura, true);
        sesion.fotos++;
        sesion.billetes += captura.billetes.length;
        sesion.monto += captura.billetes.reduce((t, b) => t + (b.denominacion || 0), 0);
        pintarResumenSesion();
      } catch (err) {
        if (!navigator.onLine || /fetch|network|failed/i.test(err.message)) {
          await encolar({
            blob: imagenes.grande, mini: imagenes.mini,
            cajera_id: cajeraId, cajera_nombre: cajeraNombre, nota,
            creado: new Date().toISOString(),
          });
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
  botones.forEach((b) => (b.disabled = false));
  $('#nota').value = '';
  // Se limpian los inputs para que elegir la misma foto otra vez vuelva a disparar el evento.
  $('#archivo-camara').value = '';
  $('#archivo-galeria').value = '';
}

function pintarCargando(cajeraNombre) {
  const div = document.createElement('div');
  div.className = 'tarjeta';
  div.innerHTML = `<p class="cargando">Leyendo los billetes de ${esc(cajeraNombre)}…</p>`;
  $('#resultados').prepend(div);
  return div;
}

// Lo que hay pintado en pantalla, para poder abrir el editor con los datos
// completos sin volver a pedirlos al servidor.
const enPantalla = new Map();
const recordar = (b) => { enPantalla.set(String(b.id), b); return b; };

function chipConfianza(b) {
  if (b.verificado) return '<span class="chip">verificado</span>';
  if (b.confianza === 'alta') return '<span class="chip">leído ok</span>';
  return `<span class="chip alerta">revisar (${esc(b.confianza || 'sin leer')})</span>`;
}

function filaBillete(b, conFoto = false) {
  recordar(b);
  const repetido = b.duplicado_de || b.repeticiones > 0;
  return `
    <div class="billete" data-billete="${b.id}">
      ${conFoto && b.url_mini ? `<img src="${esc(b.url_mini)}" alt="" loading="lazy">` : ''}
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
    <div class="contenedor-billetes" data-captura-billetes="${captura.id}" style="margin-top:.6rem">${captura.billetes.map((b) => filaBillete(b)).join('') || '<p class="tenue">No se detectó ningún billete en la foto.</p>'}</div>
    <div class="fila" style="margin-top:.5rem">
      <button class="secundario agregar" data-captura="${captura.id}" data-cajera="${captura.cajera_id}">+ Añadir billete a mano</button>
      ${captura.url_foto ? `<a href="${esc(captura.url_foto)}" target="_blank" rel="noopener" class="tenue pequeno" style="flex:0;white-space:nowrap">Ver foto</a>` : ''}
    </div>`;
  if (alPrincipio) $('#resultados').prepend(div);
  return div;
}

/* ------------------------------------------------- edición de un billete */
// Un solo formulario sirve para corregir un billete ya registrado y para
// añadir uno a mano. Guarda el contexto de lo que se está editando.
let editando = null;

function opcionesCajera(seleccionada) {
  return cajeras
    .map((c) => `<option value="${c.id}" ${String(c.id) === String(seleccionada) ? 'selected' : ''}>${esc(c.nombre)}</option>`)
    .join('');
}

/**
 * Abre el editor. Con `billete`, lo corrige; con `nuevo`, crea uno a mano en
 * la captura indicada.
 */
function abrirEditor({ billete = null, capturaId = null, cajeraId = null, destino = null } = {}) {
  const f = $('#form-billete');
  // `destino` es el contenedor concreto donde insertar. Buscarlo por selector
  // no sirve: la misma captura puede estar pintada en Registrar y en Historial.
  editando = { billete, capturaId, destino };

  $('#editor-titulo').textContent = billete ? 'Corregir billete' : 'Añadir billete a mano';
  $('#editor-foto').textContent = billete
    ? `Registrado el ${fecha(billete.creado_en)}${billete.registrado_por ? ' por ' + billete.registrado_por : ''}`
    : 'Se registra sobre la misma foto.';

  f.cajera_id.innerHTML = opcionesCajera(billete?.cajera_id ?? cajeraId);
  f.serial.value = billete?.serial && billete.serial !== '(sin leer)' ? billete.serial : '';
  f.denominacion.value = billete?.denominacion ? String(billete.denominacion) : '';
  f.serie.value = billete?.serie || '';
  f.observaciones.value = billete?.observaciones || '';
  $('#btn-eliminar').hidden = !billete;

  $('#editor').showModal();
  // En el teléfono, abrir el teclado de golpe tapa el formulario entero.
  if (!matchMedia('(max-width: 620px)').matches) f.serial.focus();
}

/** Repinta (o quita) un billete allá donde esté en pantalla. */
function refrescarBillete(id, billete) {
  for (const el of $$(`[data-billete="${id}"]`)) {
    if (!billete) { el.remove(); continue; }
    el.outerHTML = el.classList.contains('resultado') ? tarjetaResultado(billete) : filaBillete(billete);
  }
}

async function guardarBillete(evento) {
  evento.preventDefault();
  const f = $('#form-billete');
  const serial = f.serial.value.trim();
  if (!serial) return avisar('Escribe el número de serie.');

  const datos = {
    serial,
    denominacion: f.denominacion.value ? Number(f.denominacion.value) : null,
    cajera_id: Number(f.cajera_id.value),
    serie: f.serie.value.trim(),
    observaciones: f.observaciones.value.trim(),
  };

  try {
    if (editando.billete) {
      const { billete } = await apiJson(`/api/billetes/${editando.billete.id}`, 'PATCH', datos);
      refrescarBillete(billete.id, billete);
      $$('[data-fila]').forEach(actualizarCabeceraFila);
      avisar('Billete corregido.');
    } else {
      const { billete } = await apiJson('/api/billetes', 'POST', { ...datos, captura_id: editando.capturaId });
      editando.destino?.insertAdjacentHTML('beforeend', filaBillete(billete));
      actualizarCabeceraFila(editando.destino?.closest('[data-fila]'));
      avisar('Billete añadido.');
    }
    $('#editor').close();
  } catch (err) { avisar(err.message); }
}

async function eliminarBillete() {
  if (!editando?.billete) return;
  if (!confirm(`¿Eliminar el billete ${editando.billete.serial}? No se puede deshacer.`)) return;
  try {
    await api(`/api/billetes/${editando.billete.id}`, { method: 'DELETE' });
    refrescarBillete(editando.billete.id, null);
    $$('[data-fila]').forEach(actualizarCabeceraFila);
    $('#editor').close();
    avisar('Billete eliminado.');
  } catch (err) { avisar(err.message); }
}

function tarjetaResultado(b) {
  recordar(b);
  const repetido = b.repeticiones > 0 || b.duplicado_de;
  return `
    <div class="resultado" data-billete="${b.id}">
      ${b.url_mini ? `<a href="${esc(b.url_foto || b.url_mini)}" target="_blank" rel="noopener"><img src="${esc(b.url_mini)}" alt="foto del billete" loading="lazy"></a>` : ''}
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
function filaHistorial(c) {
  return `
    <div data-fila="${c.id}">
      <div class="billete" data-abrir="${c.id}" style="cursor:pointer">
        ${c.url_mini ? `<img src="${esc(c.url_mini)}" alt="" loading="lazy">` : ''}
        <div class="datos">
          <strong data-cajera-fila>${esc(c.cajera)}</strong> · <span data-resumen-fila>${c.n_billetes} billete(s) · ${dinero(c.monto)}</span>
          <div class="tenue pequeno">${fecha(c.recibida_en)}${c.nota ? ' · ' + esc(c.nota) : ''}</div>
          ${c.estado !== 'procesada' ? `<span class="chip ${c.estado === 'error' ? 'mal' : 'alerta'}">${esc(c.estado)}</span>` : ''}
        </div>
        <span class="tenue" data-flecha>▾</span>
      </div>
      <div class="detalle-captura" hidden></div>
    </div>`;
}

async function cargarHistorial() {
  $('#lista-historial').innerHTML = '<div class="tarjeta"><p class="cargando">Cargando…</p></div>';
  const { capturas } = await api('/api/capturas?limite=50');
  $('#lista-historial').innerHTML = capturas.length
    ? `<div class="tarjeta">${capturas.map(filaHistorial).join('')}</div>`
    : '<div class="tarjeta"><p class="tenue">Todavía no hay fotos registradas.</p></div>';
}

/**
 * Recalcula el "N billete(s) · $X" de una fila del historial a partir de lo
 * que hay desplegado, para que no quede desfasado al añadir o borrar.
 */
function actualizarCabeceraFila(fila) {
  const resumen = fila?.querySelector('[data-resumen-fila]');
  const panel = fila?.querySelector('.contenedor-billetes');
  if (!resumen || !panel) return;

  const billetes = [...panel.querySelectorAll('[data-billete]')]
    .map((el) => enPantalla.get(el.dataset.billete))
    .filter(Boolean);
  const monto = billetes.reduce((t, b) => t + (b.denominacion || 0), 0);
  resumen.textContent = `${billetes.length} billete(s) · ${dinero(monto)}`;
}

/** Despliega (o cierra) los billetes de una captura dentro del historial. */
async function alternarDetalle(fila, capturaId) {
  const panel = fila.querySelector('.detalle-captura');
  const flecha = fila.querySelector('[data-flecha]');

  if (!panel.hidden) {
    panel.hidden = true;
    flecha.textContent = '▾';
    return;
  }

  panel.hidden = false;
  flecha.textContent = '▴';
  panel.innerHTML = '<p class="cargando">Cargando…</p>';
  try {
    const { captura } = await api('/api/capturas/' + capturaId);
    panel.innerHTML = `
      <div class="fila" style="margin-bottom:.6rem">
        <label style="margin-bottom:0">Cajera de esta foto
          <select class="cambiar-cajera" data-captura="${captura.id}" data-anterior="${captura.cajera_id}">${opcionesCajera(captura.cajera_id)}</select>
        </label>
      </div>
      <div class="contenedor-billetes" data-captura-billetes="${captura.id}">
        ${captura.billetes.map((b) => filaBillete(b)).join('') || '<p class="tenue pequeno">Esta foto no tiene billetes registrados.</p>'}
      </div>
      <div class="fila" style="margin-top:.5rem">
        <button class="secundario agregar" data-captura="${captura.id}" data-cajera="${captura.cajera_id}">+ Añadir billete a mano</button>
        <button class="secundario reprocesar" data-id="${captura.id}" style="flex:0">Volver a leer</button>
        ${captura.url_foto ? `<a href="${esc(captura.url_foto)}" target="_blank" rel="noopener" class="tenue pequeno" style="flex:0;white-space:nowrap">Ver foto</a>` : ''}
      </div>`;
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
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

$('#btn-foto').addEventListener('click', () => $('#archivo-camara').click());
$('#btn-galeria').addEventListener('click', () => $('#archivo-galeria').click());
for (const id of ['#archivo-camara', '#archivo-galeria']) {
  $(id).addEventListener('change', (e) => manejarArchivos(e.target.files));
}

// Arrastrar fotos sobre la tarjeta (útil al trabajar desde la computadora).
const zona = $('#btn-foto').closest('.tarjeta');
for (const evento of ['dragenter', 'dragover']) {
  zona.addEventListener(evento, (e) => { e.preventDefault(); zona.classList.add('soltando'); });
}
for (const evento of ['dragleave', 'drop']) {
  zona.addEventListener(evento, (e) => { e.preventDefault(); zona.classList.remove('soltando'); });
}
zona.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) manejarArchivos(e.dataTransfer.files);
});
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
  if (editar) {
    const billete = enPantalla.get(String(editar.dataset.id));
    if (billete) abrirEditor({ billete });
    return;
  }

  const reprocesar = e.target.closest('.reprocesar');
  if (reprocesar) {
    reprocesar.disabled = true;
    try {
      const { captura } = await api(`/api/capturas/${reprocesar.dataset.id}/reprocesar`, { method: 'POST' });
      const fila = reprocesar.closest('[data-fila]');
      if (fila) {
        // Dentro del historial: se repinta solo la lista de billetes.
        fila.querySelector('.contenedor-billetes').innerHTML =
          captura.billetes.map((b) => filaBillete(b)).join('') ||
          '<p class="tenue pequeno">Esta foto no tiene billetes registrados.</p>';
        actualizarCabeceraFila(fila);
        reprocesar.disabled = false;
      } else {
        reprocesar.closest('.tarjeta').replaceWith(pintarCaptura(captura));
      }
      avisar('Foto leída de nuevo.');
    } catch (err) { avisar(err.message); reprocesar.disabled = false; }
    return;
  }

  const agregar = e.target.closest('.agregar');
  if (agregar) {
    abrirEditor({
      capturaId: Number(agregar.dataset.captura),
      cajeraId: agregar.dataset.cajera,
      destino: agregar.closest('[data-fila], .tarjeta')?.querySelector('.contenedor-billetes'),
    });
    return;
  }

  const abrir = e.target.closest('[data-abrir]');
  if (abrir) {
    alternarDetalle(abrir.closest('[data-fila]'), abrir.dataset.abrir);
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
    const estabaActiva = alternar.dataset.activa === 'true';
    await apiJson('/api/cajeras/' + alternar.dataset.id, 'PATCH', { activa: !estabaActiva });
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

// Cambiar la cajera de una foto entera (y de todos sus billetes).
document.addEventListener('change', async (e) => {
  const selector = e.target.closest('.cambiar-cajera');
  if (!selector) return;

  const fila = selector.closest('[data-fila]');
  const anterior = selector.dataset.anterior || '';
  selector.disabled = true;
  try {
    const { captura } = await apiJson('/api/capturas/' + selector.dataset.captura, 'PATCH', {
      cajera_id: Number(selector.value),
    });
    // La cabecera y los billetes desplegados llevan el nombre de la cajera.
    const nombre = fila?.querySelector('[data-cajera-fila]');
    if (nombre) nombre.textContent = captura.cajera;
    const panel = fila?.querySelector('.contenedor-billetes');
    if (panel) panel.innerHTML = captura.billetes.map((b) => filaBillete(b)).join('');
    actualizarCabeceraFila(fila);
    avisar(`Foto reasignada a ${captura.cajera}.`);
  } catch (err) {
    if (anterior) selector.value = anterior;
    avisar(err.message);
  } finally {
    selector.disabled = false;
    selector.dataset.anterior = selector.value;
  }
});

$('#form-billete').addEventListener('submit', guardarBillete);
$('#btn-cancelar').addEventListener('click', () => $('#editor').close());
$('#btn-eliminar').addEventListener('click', eliminarBillete);
$('#btn-limpiar').addEventListener('click', limpiarResultados);

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

'use strict';

const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.BUCKET_FOTOS || 'billetes';
const MINUTOS_URL = 60; // cuánto vale un enlace firmado de foto

// Con SIMULAR_ALMACEN=1 las fotos se quedan en memoria: sirve para las pruebas.
const SIMULAR = process.env.SIMULAR_ALMACEN === '1';
const enMemoria = new Map();

let clienteCache = null;
function cliente() {
  if (clienteCache) return clienteCache;
  const url = process.env.SUPABASE_URL;
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !clave) {
    throw new Error(
      'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API).'
    );
  }
  clienteCache = createClient(url, clave, { auth: { persistSession: false } });
  return clienteCache;
}

/**
 * Traduce un fallo de Supabase Storage a una frase que diga qué arreglar.
 * Nunca incluye la clave ni la URL del proyecto.
 */
function explicar(error) {
  const m = String(error?.message || error || '');
  if (/bucket not found/i.test(m)) {
    return `no existe un bucket llamado "${BUCKET}". Créalo en Supabase → Storage, o ajusta BUCKET_FOTOS.`;
  }
  if (/invalid.*(jwt|token)|jwt/i.test(m)) {
    return 'la clave no es válida — tiene que ser la "service_role", no la "anon".';
  }
  if (/row-level security|violates|unauthorized|403/i.test(m)) {
    return `sin permiso sobre el bucket "${BUCKET}" — revisa que la clave sea la "service_role".`;
  }
  if (/fetch failed|network|ENOTFOUND|getaddrinfo/i.test(m)) {
    return 'no se pudo alcanzar Supabase — revisa SUPABASE_URL.';
  }
  return m || 'error desconocido.';
}

/**
 * Comprueba que el bucket existe y es accesible. Devuelve una cadena con el
 * estado, para el diagnóstico de /api/salud.
 */
async function comprobar() {
  if (SIMULAR) return 'simulado';
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return 'faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY';
  }
  try {
    const { data, error } = await cliente().storage.getBucket(BUCKET);
    if (error) return explicar(error);
    return data?.public ? `bucket "${BUCKET}" accesible, pero es PÚBLICO: hazlo privado` : 'conectado';
  } catch (err) {
    return explicar(err);
  }
}

/** Sube una imagen y devuelve la ruta con la que se recupera después. */
async function guardar(ruta, buffer, tipo = 'image/jpeg') {
  if (SIMULAR) {
    enMemoria.set(ruta, buffer);
    return ruta;
  }
  const { error } = await cliente()
    .storage.from(BUCKET)
    .upload(ruta, buffer, { contentType: tipo, upsert: true, cacheControl: '31536000' });
  if (error) throw Object.assign(new Error(`No se pudo guardar la foto: ${explicar(error)}`), { esAlmacen: true });
  return ruta;
}

/**
 * Enlace temporal para ver una foto. El bucket es privado: sin este enlace
 * firmado nadie puede abrir las imágenes, ni conociendo la ruta.
 */
async function enlace(ruta) {
  if (!ruta) return null;
  if (SIMULAR) return `/simulado/${ruta}`;
  const { data, error } = await cliente()
    .storage.from(BUCKET)
    .createSignedUrl(ruta, MINUTOS_URL * 60);
  if (error) return null;
  return data.signedUrl;
}

/** Firma varias rutas de una vez (una sola llamada en vez de N). */
async function enlaces(rutas) {
  const limpias = [...new Set(rutas.filter(Boolean))];
  if (limpias.length === 0) return {};
  if (SIMULAR) return Object.fromEntries(limpias.map((r) => [r, `/simulado/${r}`]));

  const { data, error } = await cliente()
    .storage.from(BUCKET)
    .createSignedUrls(limpias, MINUTOS_URL * 60);
  if (error || !data) return {};
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

/** Descarga una foto ya guardada (se usa al volver a leer una captura). */
async function leer(ruta) {
  if (SIMULAR) {
    const b = enMemoria.get(ruta);
    if (!b) throw new Error('La foto ya no está guardada.');
    return b;
  }
  const { data, error } = await cliente().storage.from(BUCKET).download(ruta);
  if (error) throw Object.assign(new Error(`No se pudo leer la foto: ${explicar(error)}`), { esAlmacen: true });
  return Buffer.from(await data.arrayBuffer());
}

async function borrar(rutas) {
  if (SIMULAR) return rutas.forEach((r) => enMemoria.delete(r));
  await cliente().storage.from(BUCKET).remove(rutas);
}

module.exports = { guardar, enlace, enlaces, leer, borrar, comprobar, BUCKET };

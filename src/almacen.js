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

/** Sube una imagen y devuelve la ruta con la que se recupera después. */
async function guardar(ruta, buffer, tipo = 'image/jpeg') {
  if (SIMULAR) {
    enMemoria.set(ruta, buffer);
    return ruta;
  }
  const { error } = await cliente()
    .storage.from(BUCKET)
    .upload(ruta, buffer, { contentType: tipo, upsert: true, cacheControl: '31536000' });
  if (error) throw new Error(`No se pudo guardar la foto: ${error.message}`);
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
  if (error) throw new Error(`No se pudo leer la foto: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function borrar(rutas) {
  if (SIMULAR) return rutas.forEach((r) => enMemoria.delete(r));
  await cliente().storage.from(BUCKET).remove(rutas);
}

module.exports = { guardar, enlace, enlaces, leer, borrar, BUCKET };

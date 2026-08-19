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
    return `Supabase no encuentra el bucket "${BUCKET}". O no existe con ese nombre exacto, o la clave no tiene permiso para verlo (pasa con la clave "anon").`;
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

/** Identificador del proyecto de Supabase, recortado para no publicarlo entero. */
function proyectoAbreviado() {
  const ref = String(process.env.SUPABASE_URL || '').match(/https?:\/\/([^.]+)\./)?.[1];
  if (!ref) return null;
  return ref.length > 8 ? `${ref.slice(0, 4)}…${ref.slice(-4)}` : ref;
}

/**
 * Comprueba el almacén listando los buckets del proyecto. Listar (en vez de
 * preguntar por uno) distingue tres situaciones que Supabase confunde entre sí:
 * el bucket no existe, se llama distinto, o la clave no puede verlo (con la
 * clave "anon" las reglas de seguridad lo ocultan y responde "no encontrado").
 *
 * Devuelve { estado, detalle }. El detalle solo se enseña con sesión iniciada.
 */
async function comprobar() {
  if (SIMULAR) return { estado: 'simulado' };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { estado: 'faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY' };
  }

  try {
    const { data, error } = await cliente().storage.listBuckets();
    if (error) return { estado: explicar(error) };

    const nombres = (data || []).map((b) => b.name);
    const detalle = { esperado: BUCKET, buckets_visibles: nombres, proyecto: proyectoAbreviado() };
    const encontrado = (data || []).find((b) => b.name === BUCKET);

    if (encontrado) {
      return encontrado.public
        ? { estado: `el bucket "${BUCKET}" existe, pero es PÚBLICO: hazlo privado`, detalle }
        : { estado: 'conectado', detalle };
    }

    // Ningún bucket a la vista: casi siempre es la clave, no el bucket.
    if (nombres.length === 0) {
      return {
        estado: 'la clave no ve ningún bucket — suele ser la "anon" en vez de la "service_role", o un proyecto distinto',
        detalle,
      };
    }

    // Hay buckets, pero ninguno se llama así: es un problema de nombre.
    // El estado no nombra los otros buckets: esos van en el detalle, que solo
    // se enseña con sesión iniciada.
    const parecido = nombres.find((n) => n.toLowerCase().trim() === BUCKET.toLowerCase().trim());
    return {
      estado: parecido
        ? `hay un bucket con ese nombre pero escrito distinto, y los nombres distinguen mayúsculas y espacios (la app busca "${BUCKET}")`
        : `este proyecto tiene otros buckets, pero ninguno se llama "${BUCKET}"`,
      detalle,
    };
  } catch (err) {
    return { estado: explicar(err) };
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

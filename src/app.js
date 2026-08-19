'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { prepararEsquema, consultar, unaFila } = require('./db');
const {
  verificarPin, crearSesion, borrarSesion, usuarioDeSesion, sembrarAdmin,
} = require('./auth');
const { router: rutaCapturas } = require('./rutas/capturas');
const rutaBilletes = require('./rutas/billetes');
const rutaAdmin = require('./rutas/admin');
const rutaReportes = require('./rutas/reportes');

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// El esquema y el usuario admin se crean una sola vez por proceso, en la primera
// petición. En Vercel esto ocurre en cada arranque en frío y es idempotente.
let listo = null;
app.use((req, res, next) => {
  // El diagnóstico tiene que responder aunque la base esté caída: es
  // precisamente cuando hace falta.
  if (req.path === '/api/salud') return next();
  if (!listo) {
    listo = prepararEsquema()
      .then(() => sembrarAdmin())
      .catch((err) => { listo = null; throw err; });
  }
  listo.then(() => next()).catch(next);
});

/**
 * Traduce un fallo de conexión a Postgres en una frase accionable. Devuelve
 * null si el error no es de conexión. Nunca incluye la cadena de conexión.
 */
function descripcionDeFallo(err) {
  const codigo = err?.code;
  if (codigo === 'ECONNREFUSED' || codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') {
    return 'no responde en esa dirección — revisa DATABASE_URL (host y puerto).';
  }
  if (codigo === 'ETIMEDOUT' || /timeout/i.test(err?.message || '')) {
    return 'la conexión expiró — suele pasar al usar el puerto 5432 en vez del 6543 (pooler en modo transaction).';
  }
  if (codigo === '28P01') return 'contraseña incorrecta en DATABASE_URL.';
  if (codigo === '3D000') return 'esa base de datos no existe.';
  if (codigo === '53300') return 'demasiadas conexiones — usa el pooler de Supabase (puerto 6543).';
  if (codigo === '42501') return 'el usuario no tiene permisos para crear las tablas.';
  return null;
}

const opcionesCookie = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.COOKIE_SEGURA !== '0', // en Vercel siempre hay HTTPS
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/',
};

// --- Sesión ---------------------------------------------------------------
app.post('/api/entrar', async (req, res, next) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const usuario = await unaFila('SELECT * FROM usuarios WHERE lower(nombre) = lower($1) AND activo', [nombre]);
    if (!usuario || !verificarPin(req.body.pin, usuario.pin_hash)) {
      return res.status(401).json({ error: 'Usuario o PIN incorrecto.' });
    }
    res.cookie('sesion', await crearSesion(usuario.id), opcionesCookie);
    res.json({ usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol, cajera_id: usuario.cajera_id } });
  } catch (err) {
    next(err);
  }
});

app.post('/api/salir', async (req, res, next) => {
  try {
    await borrarSesion(req.cookies?.sesion);
    res.clearCookie('sesion', { ...opcionesCookie, maxAge: undefined });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/yo', async (req, res, next) => {
  try {
    const usuario = await usuarioDeSesion(req.cookies?.sesion);
    if (!usuario) return res.status(401).json({ error: 'Sin sesión.' });
    res.json({ usuario, modelo: require('./claude').MODELO });
  } catch (err) {
    next(err);
  }
});

/**
 * Diagnóstico: dice qué pieza está fallando sin exponer ningún valor secreto.
 * Solo informa si cada variable está puesta y si la conexión responde.
 */
app.get('/api/salud', async (req, res) => {
  const estado = {
    base_de_datos: 'sin comprobar',
    almacen_fotos: process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'configurado' : 'faltan variables',
    clave_claude: process.env.ANTHROPIC_API_KEY ? 'configurada' : 'falta ANTHROPIC_API_KEY',
    modelo: require('./claude').MODELO,
    hora: new Date().toISOString(),
  };

  try {
    await consultar('SELECT 1');
    await consultar('DELETE FROM sesiones WHERE expira_en < now()'); // limpieza barata, sin cron
    estado.base_de_datos = 'conectada';
  } catch (err) {
    estado.base_de_datos = descripcionDeFallo(err);
  }

  const todoBien = estado.base_de_datos === 'conectada' &&
    estado.almacen_fotos === 'configurado' && estado.clave_claude === 'configurada';
  res.status(todoBien ? 200 : 503).json({ ok: todoBien, ...estado });
});

// --- API ------------------------------------------------------------------
app.use('/api/capturas', rutaCapturas);
app.use('/api/billetes', rutaBilletes);
app.use('/api/reportes', rutaReportes);
app.use('/api', rutaAdmin);

// En local servimos también la interfaz; en Vercel la sirve el CDN.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'La foto pesa demasiado. Vuelve a intentarlo.' });
  }

  console.error('Error:', err?.code || '', err?.message, err?.stack?.split('\n')[1]?.trim());

  // Faltan variables de entorno o la base no responde: son problemas de
  // configuración, y decirlo ahorra horas de buscar a ciegas.
  if (/DATABASE_URL|SUPABASE_/.test(err?.message || '')) {
    return res.status(503).json({ error: err.message });
  }
  const fallo = descripcionDeFallo(err);
  if (fallo) {
    return res.status(503).json({ error: `No se pudo conectar con la base de datos: ${fallo}` });
  }

  res.status(500).json({ error: 'Error interno del servidor.' });
});

module.exports = app;

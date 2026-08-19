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
  if (!listo) {
    listo = prepararEsquema()
      .then(() => sembrarAdmin())
      .catch((err) => { listo = null; throw err; });
  }
  listo.then(() => next()).catch(next);
});

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

// Limpieza de sesiones vencidas; barata y sin cron.
app.get('/api/salud', async (req, res, next) => {
  try {
    await consultar('DELETE FROM sesiones WHERE expira_en < now()');
    res.json({ ok: true, hora: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
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
  console.error('Error:', err?.message, err?.stack?.split('\n')[1]?.trim());
  const esConfig = /DATABASE_URL|SUPABASE_/.test(err?.message || '');
  res.status(esConfig ? 503 : 500).json({
    error: esConfig ? err.message : 'Error interno del servidor.',
  });
});

module.exports = app;

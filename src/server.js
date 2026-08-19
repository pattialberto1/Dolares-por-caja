'use strict';

require('dotenv').config({ quiet: true });

const path = require('node:path');
const os = require('node:os');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db, DIR_FOTOS } = require('./db');
const {
  verificarPin, crearSesion, borrarSesion, usuarioDeSesion, requiereSesion, sembrarAdmin,
} = require('./auth');
const { router: rutaCapturas } = require('./rutas/capturas');
const rutaBilletes = require('./rutas/billetes');
const rutaAdmin = require('./rutas/admin');
const rutaReportes = require('./rutas/reportes');

const app = express();
const PUERTO = Number(process.env.PUERTO) || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// --- Sesión ---------------------------------------------------------------
app.post('/api/entrar', (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE nombre = ? AND activo = 1').get(nombre);
  if (!usuario || !verificarPin(req.body.pin, usuario.pin_hash)) {
    return res.status(401).json({ error: 'Usuario o PIN incorrecto.' });
  }
  const token = crearSesion(usuario.id);
  res.cookie('sesion', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SEGURA === '1',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol, cajera_id: usuario.cajera_id } });
});

app.post('/api/salir', (req, res) => {
  borrarSesion(req.cookies?.sesion);
  res.clearCookie('sesion');
  res.json({ ok: true });
});

app.get('/api/yo', (req, res) => {
  const usuario = usuarioDeSesion(req.cookies?.sesion);
  if (!usuario) return res.status(401).json({ error: 'Sin sesión.' });
  res.json({ usuario, modelo: require('./claude').MODELO });
});

// --- API ------------------------------------------------------------------
app.use('/api/capturas', rutaCapturas);
app.use('/api/billetes', rutaBilletes);
app.use('/api', rutaAdmin);
app.use('/api/reportes', rutaReportes);

// Las fotos solo se ven con sesión iniciada.
app.use('/fotos', requiereSesion, express.static(DIR_FOTOS, { maxAge: '30d', immutable: true }));

app.use(express.static(path.join(__dirname, '..', 'publico')));

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'La foto pesa demasiado. Vuelve a intentarlo.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

/** Direcciones de esta computadora dentro de la red local (para los teléfonos). */
function direccionesLocales() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const pinInicial = sembrarAdmin();

app.listen(PUERTO, () => {
  console.log('\n  ┌─────────────────────────────────────────────');
  console.log('  │  Dólares por caja está funcionando');
  console.log('  ├─────────────────────────────────────────────');
  console.log(`  │  En esta computadora:  http://localhost:${PUERTO}`);
  for (const ip of direccionesLocales()) {
    console.log(`  │  En el teléfono:       http://${ip}:${PUERTO}`);
  }
  console.log('  └─────────────────────────────────────────────');
  console.log('\n  (El teléfono tiene que estar en la misma red WiFi.)');

  if (pinInicial) {
    console.log(`\n  Se creó el usuario "admin" con PIN ${pinInicial}.`);
    console.log('  Entra, ve a Ajustes, cambia ese PIN y añade las cajeras.');
  }
  if (!process.env.ANTHROPIC_API_KEY && process.env.SIMULAR_LECTURA !== '1') {
    console.warn('\n  AVISO: falta ANTHROPIC_API_KEY en el archivo .env.');
    console.warn('  Sin ella la app abre, pero no puede leer los billetes.');
  }
  console.log('');
});

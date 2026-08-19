'use strict';

const crypto = require('node:crypto');
const { consultar, unaFila } = require('./db');

const DIAS_SESION = 30;

function hashPin(pin) {
  const sal = crypto.randomBytes(16).toString('hex');
  const clave = crypto.scryptSync(String(pin), sal, 64).toString('hex');
  return `${sal}:${clave}`;
}

function verificarPin(pin, hash) {
  const [sal, clave] = String(hash).split(':');
  if (!sal || !clave) return false;
  const calculada = crypto.scryptSync(String(pin), sal, 64);
  const guardada = Buffer.from(clave, 'hex');
  return calculada.length === guardada.length && crypto.timingSafeEqual(calculada, guardada);
}

async function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  await consultar(
    `INSERT INTO sesiones (token, usuario_id, expira_en)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, usuarioId, String(DIAS_SESION)]
  );
  return token;
}

async function borrarSesion(token) {
  if (token) await consultar('DELETE FROM sesiones WHERE token = $1', [token]);
}

async function usuarioDeSesion(token) {
  if (!token) return null;
  return unaFila(
    `SELECT u.id, u.nombre, u.rol, u.cajera_id
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = $1 AND s.expira_en > now() AND u.activo`,
    [token]
  );
}

/** Middleware: exige sesión válida. */
async function requiereSesion(req, res, next) {
  try {
    const usuario = await usuarioDeSesion(req.cookies?.sesion);
    if (!usuario) return res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
    req.usuario = usuario;
    next();
  } catch (err) {
    next(err);
  }
}

/** Middleware: exige rol admin. */
function requiereAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
  }
  next();
}

/**
 * Crea el usuario admin inicial si no hay ninguno. Devuelve el PIN usado la
 * primera vez, o null si ya existían usuarios.
 */
async function sembrarAdmin() {
  const { n } = await unaFila('SELECT COUNT(*)::int AS n FROM usuarios');
  if (n > 0) return null;
  const pin = process.env.PIN_ADMIN || '1234';
  // ON CONFLICT por si dos arranques simultáneos intentan sembrar a la vez.
  await consultar(
    `INSERT INTO usuarios (nombre, pin_hash, rol) VALUES ('admin', $1, 'admin')
     ON CONFLICT (nombre) DO NOTHING`,
    [hashPin(pin)]
  );
  return pin;
}

module.exports = {
  hashPin, verificarPin, crearSesion, borrarSesion,
  usuarioDeSesion, requiereSesion, requiereAdmin, sembrarAdmin,
};

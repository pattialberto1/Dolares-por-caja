'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');

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

function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sesiones (token, usuario_id, expira_en)
     VALUES (?, ?, datetime('now', '+${DIAS_SESION} days'))`
  ).run(token, usuarioId);
  return token;
}

function borrarSesion(token) {
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
}

function usuarioDeSesion(token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.nombre, u.rol, u.cajera_id
           FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token = ? AND s.expira_en > datetime('now') AND u.activo = 1`
      )
      .get(token) || null
  );
}

/** Middleware: exige sesión válida. */
function requiereSesion(req, res, next) {
  const usuario = usuarioDeSesion(req.cookies?.sesion);
  if (!usuario) return res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
  req.usuario = usuario;
  next();
}

/** Middleware: exige rol admin. */
function requiereAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
  }
  next();
}

/** Crea el usuario admin inicial si la tabla está vacía. */
function sembrarAdmin() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
  if (total > 0) return null;
  const pin = process.env.PIN_ADMIN || '1234';
  db.prepare('INSERT INTO usuarios (nombre, pin_hash, rol) VALUES (?, ?, ?)').run(
    'admin',
    hashPin(pin),
    'admin'
  );
  return pin;
}

module.exports = {
  hashPin,
  verificarPin,
  crearSesion,
  borrarSesion,
  usuarioDeSesion,
  requiereSesion,
  requiereAdmin,
  sembrarAdmin,
};

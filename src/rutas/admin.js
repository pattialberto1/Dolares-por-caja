'use strict';

const express = require('express');
const { db } = require('../db');
const { requiereSesion, requiereAdmin, hashPin } = require('../auth');

const router = express.Router();

// --- Cajeras ---------------------------------------------------------------
router.get('/cajeras', requiereSesion, (req, res) => {
  const todas = req.query.todas === '1';
  const filas = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM billetes b WHERE b.cajera_id = c.id) AS n_billetes
         FROM cajeras c ${todas ? '' : 'WHERE c.activa = 1'}
        ORDER BY c.activa DESC, c.nombre`
    )
    .all();
  res.json({ cajeras: filas });
});

router.post('/cajeras', requiereSesion, requiereAdmin, (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre de la cajera.' });
  try {
    const info = db.prepare('INSERT INTO cajeras (nombre) VALUES (?)').run(nombre);
    res.json({ cajera: db.prepare('SELECT * FROM cajeras WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: 'Ya existe una cajera con ese nombre.' });
  }
});

router.patch('/cajeras/:id', requiereSesion, requiereAdmin, (req, res) => {
  const cajera = db.prepare('SELECT * FROM cajeras WHERE id = ?').get(req.params.id);
  if (!cajera) return res.status(404).json({ error: 'Cajera no encontrada.' });
  db.prepare('UPDATE cajeras SET nombre = ?, activa = ? WHERE id = ?').run(
    req.body.nombre !== undefined ? String(req.body.nombre).trim() : cajera.nombre,
    req.body.activa !== undefined ? (req.body.activa ? 1 : 0) : cajera.activa,
    cajera.id
  );
  res.json({ cajera: db.prepare('SELECT * FROM cajeras WHERE id = ?').get(cajera.id) });
});

// --- Usuarios --------------------------------------------------------------
router.get('/usuarios', requiereSesion, requiereAdmin, (req, res) => {
  res.json({
    usuarios: db
      .prepare(
        `SELECT u.id, u.nombre, u.rol, u.activo, u.creado_en, c.nombre AS cajera
           FROM usuarios u LEFT JOIN cajeras c ON c.id = u.cajera_id
          ORDER BY u.nombre`
      )
      .all(),
  });
});

router.post('/usuarios', requiereSesion, requiereAdmin, (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  const pin = String(req.body.pin || '');
  if (!nombre || pin.length < 4) {
    return res.status(400).json({ error: 'Hace falta un nombre y un PIN de al menos 4 dígitos.' });
  }
  try {
    const info = db
      .prepare('INSERT INTO usuarios (nombre, pin_hash, rol, cajera_id) VALUES (?, ?, ?, ?)')
      .run(nombre, hashPin(pin), req.body.rol === 'admin' ? 'admin' : 'operador', Number(req.body.cajera_id) || null);
    res.json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Ya existe un usuario con ese nombre.' });
  }
});

// Un admin puede tocar cualquier usuario; cualquiera puede cambiar su propio PIN.
router.patch('/usuarios/:id', requiereSesion, (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const esPropio = usuario.id === req.usuario.id;
  if (!esPropio && req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
  }
  if (esPropio && req.usuario.rol !== 'admin' && req.body.activo !== undefined) {
    return res.status(403).json({ error: 'No puedes cambiar tu propio estado.' });
  }
  if (req.body.pin) {
    if (String(req.body.pin).length < 4) return res.status(400).json({ error: 'El PIN debe tener al menos 4 dígitos.' });
    db.prepare('UPDATE usuarios SET pin_hash = ? WHERE id = ?').run(hashPin(String(req.body.pin)), usuario.id);
  }
  if (req.body.activo !== undefined) {
    db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(req.body.activo ? 1 : 0, usuario.id);
  }
  res.json({ ok: true });
});

module.exports = router;

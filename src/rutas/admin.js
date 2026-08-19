'use strict';

const express = require('express');
const { consultar, unaFila } = require('../db');
const { requiereSesion, requiereAdmin, hashPin } = require('../auth');

const router = express.Router();

const esUnico = (err) => err?.code === '23505'; // unique_violation en Postgres

/** Acepta true/false, 1/0 y "1"/"0" indistintamente. */
const aBooleano = (v) => v === true || v === 1 || v === '1' || v === 'true';

// --- Cajeras ---------------------------------------------------------------
router.get('/cajeras', requiereSesion, async (req, res, next) => {
  try {
    const cajeras = await consultar(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM billetes b WHERE b.cajera_id = c.id) AS n_billetes
         FROM cajeras c ${req.query.todas === '1' ? '' : 'WHERE c.activa'}
        ORDER BY c.activa DESC, c.nombre`
    );
    res.json({ cajeras });
  } catch (err) {
    next(err);
  }
});

router.post('/cajeras', requiereSesion, requiereAdmin, async (req, res, next) => {
  const nombre = String(req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre de la cajera.' });
  try {
    const cajera = await unaFila('INSERT INTO cajeras (nombre) VALUES ($1) RETURNING *', [nombre]);
    res.json({ cajera });
  } catch (err) {
    if (esUnico(err)) return res.status(400).json({ error: 'Ya existe una cajera con ese nombre.' });
    next(err);
  }
});

router.patch('/cajeras/:id', requiereSesion, requiereAdmin, async (req, res, next) => {
  try {
    const cajera = await unaFila('SELECT * FROM cajeras WHERE id = $1', [Number(req.params.id) || 0]);
    if (!cajera) return res.status(404).json({ error: 'Cajera no encontrada.' });

    const actualizada = await unaFila(
      'UPDATE cajeras SET nombre = $1, activa = $2 WHERE id = $3 RETURNING *',
      [
        req.body.nombre !== undefined ? String(req.body.nombre).trim() : cajera.nombre,
        req.body.activa !== undefined ? aBooleano(req.body.activa) : cajera.activa,
        cajera.id,
      ]
    );
    res.json({ cajera: actualizada });
  } catch (err) {
    if (esUnico(err)) return res.status(400).json({ error: 'Ya existe una cajera con ese nombre.' });
    next(err);
  }
});

// --- Usuarios --------------------------------------------------------------
router.get('/usuarios', requiereSesion, requiereAdmin, async (req, res, next) => {
  try {
    const usuarios = await consultar(
      `SELECT u.id, u.nombre, u.rol, u.activo, u.creado_en, c.nombre AS cajera
         FROM usuarios u LEFT JOIN cajeras c ON c.id = u.cajera_id
        ORDER BY u.nombre`
    );
    res.json({ usuarios });
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios', requiereSesion, requiereAdmin, async (req, res, next) => {
  const nombre = String(req.body.nombre || '').trim();
  const pin = String(req.body.pin || '');
  if (!nombre || pin.length < 4) {
    return res.status(400).json({ error: 'Hace falta un nombre y un PIN de al menos 4 dígitos.' });
  }
  try {
    const fila = await unaFila(
      'INSERT INTO usuarios (nombre, pin_hash, rol, cajera_id) VALUES ($1,$2,$3,$4) RETURNING id',
      [nombre, hashPin(pin), req.body.rol === 'admin' ? 'admin' : 'operador', Number(req.body.cajera_id) || null]
    );
    res.json({ id: fila.id });
  } catch (err) {
    if (esUnico(err)) return res.status(400).json({ error: 'Ya existe un usuario con ese nombre.' });
    next(err);
  }
});

// Un admin puede tocar cualquier usuario; cualquiera puede cambiar su propio PIN.
router.patch('/usuarios/:id', requiereSesion, async (req, res, next) => {
  try {
    const usuario = await unaFila('SELECT * FROM usuarios WHERE id = $1', [Number(req.params.id) || 0]);
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const esPropio = String(usuario.id) === String(req.usuario.id);
    if (!esPropio && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
    }
    if (esPropio && req.usuario.rol !== 'admin' && req.body.activo !== undefined) {
      return res.status(403).json({ error: 'No puedes cambiar tu propio estado.' });
    }

    if (req.body.pin) {
      if (String(req.body.pin).length < 4) {
        return res.status(400).json({ error: 'El PIN debe tener al menos 4 dígitos.' });
      }
      await consultar('UPDATE usuarios SET pin_hash = $1 WHERE id = $2', [hashPin(String(req.body.pin)), usuario.id]);
      // Cambiar el PIN cierra las demás sesiones de esa persona.
      await consultar('DELETE FROM sesiones WHERE usuario_id = $1 AND token <> $2', [
        usuario.id, req.cookies?.sesion || '',
      ]);
    }
    if (req.body.activo !== undefined) {
      await consultar('UPDATE usuarios SET activo = $1 WHERE id = $2', [aBooleano(req.body.activo), usuario.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

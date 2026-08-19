'use strict';

const express = require('express');
const { db, normalizarSerial } = require('../db');
const { requiereSesion } = require('../auth');

const router = express.Router();

const SELECT_BILLETE = `
  SELECT b.id, b.serial, b.serial_norm, b.denominacion, b.serie, b.letra_distrito,
         b.confianza, b.observaciones, b.verificado, b.duplicado_de, b.creado_en,
         b.captura_id, c.nombre AS cajera, c.id AS cajera_id,
         cap.archivo, cap.miniatura, cap.nota, cap.recibida_en, u.nombre AS registrado_por
    FROM billetes b
    JOIN cajeras c ON c.id = b.cajera_id
    JOIN capturas cap ON cap.id = b.captura_id
    LEFT JOIN usuarios u ON u.id = cap.usuario_id`;

// --- Búsqueda por serial ---------------------------------------------------
// Acepta el serial completo o un fragmento (p. ej. los últimos 4 dígitos).
router.get('/buscar', requiereSesion, (req, res) => {
  const q = normalizarSerial(req.query.q);
  if (q.length < 3) {
    return res.status(400).json({ error: 'Escribe al menos 3 caracteres del serial.' });
  }

  const exactos = db.prepare(`${SELECT_BILLETE} WHERE b.serial_norm = ? ORDER BY b.creado_en DESC`).all(q);
  const parciales = db
    .prepare(
      `${SELECT_BILLETE} WHERE b.serial_norm LIKE ? AND b.serial_norm <> ?
        ORDER BY b.creado_en DESC LIMIT 50`
    )
    .all(`%${q}%`, q);

  res.json({ consulta: q, exactos, parciales, total: exactos.length + parciales.length });
});

// --- Seriales repetidos (mismo número visto más de una vez) ----------------
router.get('/repetidos', requiereSesion, (req, res) => {
  const filas = db
    .prepare(
      `SELECT serial_norm, COUNT(*) AS veces,
              GROUP_CONCAT(DISTINCT c.nombre) AS cajeras,
              MIN(b.creado_en) AS primera, MAX(b.creado_en) AS ultima
         FROM billetes b JOIN cajeras c ON c.id = b.cajera_id
        WHERE b.serial_norm <> '' AND b.serial_norm NOT LIKE '%?%'
        GROUP BY b.serial_norm HAVING COUNT(*) > 1
        ORDER BY ultima DESC LIMIT 100`
    )
    .all();
  res.json({ repetidos: filas });
});

// --- Corrección manual de un billete --------------------------------------
router.patch('/:id', requiereSesion, (req, res) => {
  const billete = db.prepare('SELECT * FROM billetes WHERE id = ?').get(req.params.id);
  if (!billete) return res.status(404).json({ error: 'Billete no encontrado.' });

  const serial = req.body.serial !== undefined ? String(req.body.serial).trim() : billete.serial;
  const denominacion =
    req.body.denominacion !== undefined ? Number(req.body.denominacion) || null : billete.denominacion;
  const cajeraId = req.body.cajera_id !== undefined ? Number(req.body.cajera_id) : billete.cajera_id;

  if (!db.prepare('SELECT 1 FROM cajeras WHERE id = ?').get(cajeraId)) {
    return res.status(400).json({ error: 'Cajera no válida.' });
  }

  db.prepare(
    `UPDATE billetes
        SET serial = ?, serial_norm = ?, denominacion = ?, cajera_id = ?,
            serie = COALESCE(?, serie), observaciones = COALESCE(?, observaciones),
            confianza = 'alta', verificado = 1
      WHERE id = ?`
  ).run(
    serial,
    normalizarSerial(serial),
    denominacion,
    cajeraId,
    req.body.serie ?? null,
    req.body.observaciones ?? null,
    billete.id
  );

  res.json({ billete: db.prepare(`${SELECT_BILLETE} WHERE b.id = ?`).get(billete.id) });
});

// --- Añadir un billete a mano a una captura -------------------------------
router.post('/', requiereSesion, (req, res) => {
  const captura = db.prepare('SELECT * FROM capturas WHERE id = ?').get(Number(req.body.captura_id));
  if (!captura) return res.status(400).json({ error: 'Captura no válida.' });

  const serial = String(req.body.serial || '').trim();
  if (!serial) return res.status(400).json({ error: 'Escribe el serial.' });

  const info = db
    .prepare(
      `INSERT INTO billetes
         (captura_id, cajera_id, serial, serial_norm, denominacion, serie, confianza, verificado)
       VALUES (?, ?, ?, ?, ?, ?, 'alta', 1)`
    )
    .run(
      captura.id,
      Number(req.body.cajera_id) || captura.cajera_id,
      serial,
      normalizarSerial(serial),
      Number(req.body.denominacion) || null,
      req.body.serie || null
    );

  res.json({ billete: db.prepare(`${SELECT_BILLETE} WHERE b.id = ?`).get(info.lastInsertRowid) });
});

router.delete('/:id', requiereSesion, (req, res) => {
  // Otro billete puede apuntar a este como "duplicado_de": se suelta primero.
  const borrar = db.transaction((id) => {
    db.prepare('UPDATE billetes SET duplicado_de = NULL WHERE duplicado_de = ?').run(id);
    db.prepare('DELETE FROM billetes WHERE id = ?').run(id);
  });
  borrar(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

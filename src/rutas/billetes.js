'use strict';

const express = require('express');
const { consultar, unaFila, enTransaccion, normalizarSerial } = require('../db');
const almacen = require('../almacen');
const { requiereSesion } = require('../auth');

const router = express.Router();

const SELECT_BILLETE = `
  SELECT b.id, b.serial, b.serial_norm, b.denominacion, b.serie, b.letra_distrito,
         b.confianza, b.observaciones, b.verificado, b.duplicado_de, b.creado_en,
         b.captura_id, c.nombre AS cajera, c.id AS cajera_id,
         cap.archivo, cap.miniatura, cap.nota, cap.recibida_en, u.nombre AS registrado_por,
         (SELECT COUNT(*)::int FROM billetes o
           WHERE o.serial_norm = b.serial_norm AND o.id <> b.id) AS repeticiones
    FROM billetes b
    JOIN cajeras c ON c.id = b.cajera_id
    JOIN capturas cap ON cap.id = b.captura_id
    LEFT JOIN usuarios u ON u.id = cap.usuario_id`;

async function conFotos(filas) {
  const urls = await almacen.enlaces(filas.flatMap((f) => [f.archivo, f.miniatura]));
  return filas.map((f) => ({ ...f, url_foto: urls[f.archivo] || null, url_mini: urls[f.miniatura] || null }));
}

// --- Búsqueda por serial ---------------------------------------------------
// Acepta el serial completo o un fragmento (p. ej. los últimos 4 dígitos).
router.get('/buscar', requiereSesion, async (req, res, next) => {
  try {
    const q = normalizarSerial(req.query.q);
    if (q.length < 3) return res.status(400).json({ error: 'Escribe al menos 3 caracteres del serial.' });

    const exactos = await consultar(`${SELECT_BILLETE} WHERE b.serial_norm = $1 ORDER BY b.creado_en DESC`, [q]);
    const parciales = await consultar(
      `${SELECT_BILLETE} WHERE b.serial_norm LIKE $1 AND b.serial_norm <> $2
        ORDER BY b.creado_en DESC LIMIT 50`,
      [`%${q}%`, q]
    );

    const [conUrlExactos, conUrlParciales] = await Promise.all([conFotos(exactos), conFotos(parciales)]);
    res.json({
      consulta: q,
      exactos: conUrlExactos,
      parciales: conUrlParciales,
      total: exactos.length + parciales.length,
    });
  } catch (err) {
    next(err);
  }
});

// --- Seriales repetidos ----------------------------------------------------
router.get('/repetidos', requiereSesion, async (req, res, next) => {
  try {
    const repetidos = await consultar(
      `SELECT b.serial_norm, COUNT(*)::int AS veces,
              string_agg(DISTINCT c.nombre, ', ') AS cajeras,
              MIN(b.creado_en) AS primera, MAX(b.creado_en) AS ultima
         FROM billetes b JOIN cajeras c ON c.id = b.cajera_id
        WHERE b.serial_norm <> '' AND b.serial_norm NOT LIKE '%?%'
        GROUP BY b.serial_norm HAVING COUNT(*) > 1
        ORDER BY MAX(b.creado_en) DESC LIMIT 100`
    );
    res.json({ repetidos });
  } catch (err) {
    next(err);
  }
});

// --- Corrección manual de un billete --------------------------------------
router.patch('/:id', requiereSesion, async (req, res, next) => {
  try {
    const billete = await unaFila('SELECT * FROM billetes WHERE id = $1', [Number(req.params.id) || 0]);
    if (!billete) return res.status(404).json({ error: 'Billete no encontrado.' });

    const serial = req.body.serial !== undefined ? String(req.body.serial).trim() : billete.serial;
    const denominacion =
      req.body.denominacion !== undefined ? Number(req.body.denominacion) || null : billete.denominacion;
    const cajeraId = req.body.cajera_id !== undefined ? Number(req.body.cajera_id) : billete.cajera_id;

    if (!(await unaFila('SELECT 1 FROM cajeras WHERE id = $1', [cajeraId]))) {
      return res.status(400).json({ error: 'Cajera no válida.' });
    }

    await consultar(
      `UPDATE billetes
          SET serial = $1, serial_norm = $2, denominacion = $3, cajera_id = $4,
              serie = COALESCE($5, serie), observaciones = COALESCE($6, observaciones),
              confianza = 'alta', verificado = true
        WHERE id = $7`,
      [serial, normalizarSerial(serial), denominacion, cajeraId, req.body.serie ?? null, req.body.observaciones ?? null, billete.id]
    );

    const [actualizado] = await conFotos([await unaFila(`${SELECT_BILLETE} WHERE b.id = $1`, [billete.id])]);
    res.json({ billete: actualizado });
  } catch (err) {
    next(err);
  }
});

// --- Añadir un billete a mano a una captura -------------------------------
router.post('/', requiereSesion, async (req, res, next) => {
  try {
    const captura = await unaFila('SELECT * FROM capturas WHERE id = $1', [Number(req.body.captura_id) || 0]);
    if (!captura) return res.status(400).json({ error: 'Captura no válida.' });

    const serial = String(req.body.serial || '').trim();
    if (!serial) return res.status(400).json({ error: 'Escribe el serial.' });

    const fila = await unaFila(
      `INSERT INTO billetes
         (captura_id, cajera_id, serial, serial_norm, denominacion, serie, confianza, verificado)
       VALUES ($1,$2,$3,$4,$5,$6,'alta',true) RETURNING id`,
      [
        captura.id,
        Number(req.body.cajera_id) || captura.cajera_id,
        serial,
        normalizarSerial(serial),
        Number(req.body.denominacion) || null,
        req.body.serie || null,
      ]
    );

    const [nuevo] = await conFotos([await unaFila(`${SELECT_BILLETE} WHERE b.id = $1`, [fila.id])]);
    res.json({ billete: nuevo });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requiereSesion, async (req, res, next) => {
  try {
    // Otro billete puede apuntar a este como "duplicado_de": se suelta primero.
    await enTransaccion(async (cliente) => {
      const id = Number(req.params.id) || 0;
      await cliente.query('UPDATE billetes SET duplicado_de = NULL WHERE duplicado_de = $1', [id]);
      await cliente.query('DELETE FROM billetes WHERE id = $1', [id]);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

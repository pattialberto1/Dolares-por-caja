'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { db, DIR_FOTOS, normalizarSerial } = require('../db');
const { leerBilletes } = require('../claude');
const { requiereSesion } = require('../auth');

const router = express.Router();
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// px del lado mayor. Más grande = lee mejor seriales borrosos, pero cuesta más
// tokens (el costo sube con el área de la imagen). 1800 es un buen equilibrio.
const MAX_LADO = Number(process.env.MAX_LADO_PX) || 1800;

async function guardarImagen(buffer) {
  const grande = await sharp(buffer)
    .rotate() // respeta la orientación EXIF del teléfono
    .resize({ width: MAX_LADO, height: MAX_LADO, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  const hash = crypto.createHash('sha256').update(grande).digest('hex');
  const nombre = `${hash.slice(0, 24)}.jpg`;
  const nombreMini = `${hash.slice(0, 24)}_mini.jpg`;

  fs.writeFileSync(path.join(DIR_FOTOS, nombre), grande);
  const mini = await sharp(grande).resize({ width: 360, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
  fs.writeFileSync(path.join(DIR_FOTOS, nombreMini), mini);

  return { buffer: grande, hash, archivo: nombre, miniatura: nombreMini };
}

function billetesDeCaptura(capturaId) {
  return db
    .prepare(
      `SELECT b.*, c.nombre AS cajera,
              (SELECT COUNT(*) FROM billetes o
                WHERE o.serial_norm = b.serial_norm AND o.id <> b.id) AS repeticiones
         FROM billetes b JOIN cajeras c ON c.id = b.cajera_id
        WHERE b.captura_id = ?
        ORDER BY b.id`
    )
    .all(capturaId);
}

function capturaCompleta(id) {
  const captura = db
    .prepare(
      `SELECT cap.*, c.nombre AS cajera, u.nombre AS usuario
         FROM capturas cap
         JOIN cajeras c ON c.id = cap.cajera_id
    LEFT JOIN usuarios u ON u.id = cap.usuario_id
        WHERE cap.id = ?`
    )
    .get(id);
  if (!captura) return null;
  return { ...captura, billetes: billetesDeCaptura(id) };
}

/** Registra los billetes leídos, marcando los seriales ya vistos antes. */
function guardarLectura(capturaId, cajeraId, lectura) {
  const insertar = db.prepare(
    `INSERT INTO billetes
       (captura_id, cajera_id, serial, serial_norm, denominacion, serie,
        letra_distrito, confianza, observaciones, duplicado_de)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const buscarPrevio = db.prepare(
    `SELECT id FROM billetes WHERE serial_norm = ? AND captura_id <> ? ORDER BY id LIMIT 1`
  );

  const tx = db.transaction((billetes) => {
    for (const b of billetes) {
      const norm = normalizarSerial(b.serial);
      // Un serial ilegible o vacío no se compara contra el histórico.
      const previo = norm && !norm.includes('?') ? buscarPrevio.get(norm, capturaId) : null;
      insertar.run(
        capturaId,
        cajeraId,
        String(b.serial || '').trim(),
        norm,
        Number.isFinite(b.denominacion) ? b.denominacion : null,
        b.serie || null,
        b.letra_distrito || null,
        b.confianza || null,
        b.observaciones || null,
        previo ? previo.id : null
      );
    }
  });
  tx(lectura.billetes || []);
}

async function procesar(capturaId, cajeraId, buffer) {
  try {
    const r = await leerBilletes(buffer, 'image/jpeg');
    guardarLectura(capturaId, cajeraId, r.lectura);

    const dudosos = (r.lectura.billetes || []).filter(
      (b) => b.confianza !== 'alta' || !b.serial || String(b.serial).includes('?')
    ).length;
    const estado = (r.lectura.billetes || []).length === 0 || dudosos > 0 ? 'revisar' : 'procesada';

    db.prepare(
      `UPDATE capturas
          SET estado = ?, error = NULL, modelo = ?, tokens_in = ?, tokens_out = ?,
              costo_usd = ?, nota = COALESCE(NULLIF(nota, ''), ?),
              procesada_en = datetime('now')
        WHERE id = ?`
    ).run(estado, r.modelo, r.tokens_in, r.tokens_out, r.costo_usd, r.lectura.nota_general || null, capturaId);
  } catch (err) {
    db.prepare(`UPDATE capturas SET estado = 'error', error = ? WHERE id = ?`).run(
      String(err?.message || err).slice(0, 500),
      capturaId
    );
  }
}

// --- Subir una foto -------------------------------------------------------
router.post('/', requiereSesion, subida.single('foto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta la foto.' });

  const cajeraId = Number(req.body.cajera_id);
  const cajera = db.prepare('SELECT * FROM cajeras WHERE id = ?').get(cajeraId);
  if (!cajera) return res.status(400).json({ error: 'Selecciona una cajera válida.' });

  let img;
  try {
    img = await guardarImagen(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'El archivo no es una imagen válida.' });
  }

  const yaExiste = db.prepare('SELECT id FROM capturas WHERE hash_foto = ?').get(img.hash);
  if (yaExiste) {
    return res.json({ repetida: true, captura: capturaCompleta(yaExiste.id) });
  }

  const info = db
    .prepare(
      `INSERT INTO capturas (archivo, miniatura, hash_foto, cajera_id, usuario_id, nota)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(img.archivo, img.miniatura, img.hash, cajeraId, req.usuario.id, req.body.nota || null);

  await procesar(info.lastInsertRowid, cajeraId, img.buffer);
  res.json({ repetida: false, captura: capturaCompleta(info.lastInsertRowid) });
});

// --- Reintentar la lectura de una foto ------------------------------------
router.post('/:id/reprocesar', requiereSesion, async (req, res) => {
  const captura = db.prepare('SELECT * FROM capturas WHERE id = ?').get(req.params.id);
  if (!captura) return res.status(404).json({ error: 'Captura no encontrada.' });

  const limpiar = db.transaction((capturaId) => {
    db.prepare(
      `UPDATE billetes SET duplicado_de = NULL
        WHERE duplicado_de IN (SELECT id FROM billetes WHERE captura_id = ?)`
    ).run(capturaId);
    db.prepare('DELETE FROM billetes WHERE captura_id = ?').run(capturaId);
  });
  limpiar(captura.id);
  const buffer = fs.readFileSync(path.join(DIR_FOTOS, captura.archivo));
  await procesar(captura.id, captura.cajera_id, buffer);
  res.json({ captura: capturaCompleta(captura.id) });
});

// --- Listado de capturas recientes ----------------------------------------
router.get('/', requiereSesion, (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 30, 200);
  const filas = db
    .prepare(
      `SELECT cap.id, cap.archivo, cap.miniatura, cap.estado, cap.nota, cap.recibida_en,
              c.nombre AS cajera,
              (SELECT COUNT(*) FROM billetes b WHERE b.captura_id = cap.id) AS n_billetes,
              (SELECT COALESCE(SUM(b.denominacion), 0) FROM billetes b WHERE b.captura_id = cap.id) AS monto
         FROM capturas cap JOIN cajeras c ON c.id = cap.cajera_id
        ORDER BY cap.id DESC LIMIT ?`
    )
    .all(limite);
  res.json({ capturas: filas });
});

router.get('/:id', requiereSesion, (req, res) => {
  const captura = capturaCompleta(req.params.id);
  if (!captura) return res.status(404).json({ error: 'Captura no encontrada.' });
  res.json({ captura });
});

module.exports = { router, capturaCompleta };

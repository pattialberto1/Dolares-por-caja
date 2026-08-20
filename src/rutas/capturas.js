'use strict';

const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { consultar, unaFila, enTransaccion, normalizarSerial } = require('../db');
const almacen = require('../almacen');
const { leerBilletes } = require('../claude');
const { requiereSesion } = require('../auth');

const router = express.Router();

// La foto ya viene encogida desde el teléfono; este límite es solo una red de
// seguridad (Vercel además corta los cuerpos por encima de ~4,5 MB).
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 2 } });

const TIPOS = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Añade a cada fila los enlaces firmados de su foto y su miniatura. */
async function conFotos(filas) {
  const urls = await almacen.enlaces(filas.flatMap((f) => [f.archivo, f.miniatura]));
  return filas.map((f) => ({ ...f, url_foto: urls[f.archivo] || null, url_mini: urls[f.miniatura] || null }));
}

async function billetesDeCaptura(capturaId) {
  return consultar(
    `SELECT b.*, c.nombre AS cajera,
            (SELECT COUNT(*)::int FROM billetes o
              WHERE o.serial_norm = b.serial_norm AND o.id <> b.id) AS repeticiones
       FROM billetes b JOIN cajeras c ON c.id = b.cajera_id
      WHERE b.captura_id = $1
      ORDER BY b.id`,
    [capturaId]
  );
}

async function capturaCompleta(id) {
  const captura = await unaFila(
    `SELECT cap.*, c.nombre AS cajera, u.nombre AS usuario
       FROM capturas cap
       JOIN cajeras c ON c.id = cap.cajera_id
  LEFT JOIN usuarios u ON u.id = cap.usuario_id
      WHERE cap.id = $1`,
    [id]
  );
  if (!captura) return null;
  const [conUrl] = await conFotos([captura]);
  return { ...conUrl, billetes: await billetesDeCaptura(id) };
}

/** Registra los billetes leídos, marcando los seriales ya vistos antes. */
async function guardarLectura(capturaId, cajeraId, lectura) {
  const billetes = lectura.billetes || [];
  if (billetes.length === 0) return;

  await enTransaccion(async (cliente) => {
    for (const b of billetes) {
      const norm = normalizarSerial(b.serial);
      // Un serial ilegible o vacío no se compara contra el histórico.
      let previo = null;
      if (norm && !norm.includes('?')) {
        const r = await cliente.query(
          'SELECT id FROM billetes WHERE serial_norm = $1 AND captura_id <> $2 ORDER BY id LIMIT 1',
          [norm, capturaId]
        );
        previo = r.rows[0]?.id ?? null;
      }
      await cliente.query(
        `INSERT INTO billetes
           (captura_id, cajera_id, serial, serial_norm, denominacion, serie,
            letra_distrito, confianza, observaciones, duplicado_de)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          capturaId,
          cajeraId,
          String(b.serial || '').trim(),
          norm,
          Number.isFinite(b.denominacion) && b.denominacion > 0 ? b.denominacion : null,
          b.serie || null,
          b.letra_distrito || null,
          b.confianza || null,
          b.observaciones || null,
          previo,
        ]
      );
    }
  });
}

async function procesar(capturaId, cajeraId, buffer, tipo) {
  try {
    const r = await leerBilletes(buffer, tipo);
    await guardarLectura(capturaId, cajeraId, r.lectura);

    const leidos = r.lectura.billetes || [];
    const dudosos = leidos.filter((b) => b.confianza !== 'alta' || !b.serial || String(b.serial).includes('?')).length;
    const estado = leidos.length === 0 || dudosos > 0 ? 'revisar' : 'procesada';

    await consultar(
      `UPDATE capturas
          SET estado = $1, error = NULL, modelo = $2, tokens_in = $3, tokens_out = $4,
              costo_usd = $5, nota = COALESCE(NULLIF(nota, ''), $6), procesada_en = now()
        WHERE id = $7`,
      [estado, r.modelo, r.tokens_in, r.tokens_out, r.costo_usd, r.lectura.nota_general || null, capturaId]
    );
  } catch (err) {
    await consultar(`UPDATE capturas SET estado = 'error', error = $1 WHERE id = $2`, [
      String(err?.message || err).slice(0, 500),
      capturaId,
    ]);
  }
}

// --- Subir una foto -------------------------------------------------------
// Se esperan dos archivos: "foto" (la grande, la que lee Claude) y opcionalmente
// "mini" (la miniatura, que genera el teléfono para no gastar datos en las listas).
router.post('/', requiereSesion, subida.fields([{ name: 'foto', maxCount: 1 }, { name: 'mini', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const foto = req.files?.foto?.[0];
      const mini = req.files?.mini?.[0];
      if (!foto) return res.status(400).json({ error: 'Falta la foto.' });
      if (!TIPOS.has(foto.mimetype)) return res.status(400).json({ error: 'El archivo no es una imagen.' });

      const cajeraId = Number(req.body.cajera_id);
      const cajera = await unaFila('SELECT id FROM cajeras WHERE id = $1', [cajeraId]);
      if (!cajera) return res.status(400).json({ error: 'Selecciona una cajera válida.' });

      const hash = crypto.createHash('sha256').update(foto.buffer).digest('hex');
      const yaExiste = await unaFila('SELECT id FROM capturas WHERE hash_foto = $1', [hash]);
      if (yaExiste) return res.json({ repetida: true, captura: await capturaCompleta(yaExiste.id) });

      const base = `${new Date().toISOString().slice(0, 7)}/${hash.slice(0, 24)}`;
      const rutaFoto = await almacen.guardar(`${base}.jpg`, foto.buffer, foto.mimetype);
      const rutaMini = mini ? await almacen.guardar(`${base}_mini.jpg`, mini.buffer, mini.mimetype) : null;

      const fila = await unaFila(
        `INSERT INTO capturas (archivo, miniatura, hash_foto, cajera_id, usuario_id, nota)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [rutaFoto, rutaMini, hash, cajeraId, req.usuario.id, req.body.nota || null]
      );

      await procesar(fila.id, cajeraId, foto.buffer, foto.mimetype);
      res.json({ repetida: false, captura: await capturaCompleta(fila.id) });
    } catch (err) {
      next(err);
    }
  }
);

// --- Reintentar la lectura de una foto ------------------------------------
router.post('/:id/reprocesar', requiereSesion, async (req, res, next) => {
  try {
    const captura = await unaFila('SELECT * FROM capturas WHERE id = $1', [Number(req.params.id) || 0]);
    if (!captura) return res.status(404).json({ error: 'Captura no encontrada.' });

    await consultar('DELETE FROM billetes WHERE captura_id = $1', [captura.id]);
    const buffer = await almacen.leer(captura.archivo);
    await procesar(captura.id, captura.cajera_id, buffer, 'image/jpeg');
    res.json({ captura: await capturaCompleta(captura.id) });
  } catch (err) {
    next(err);
  }
});

// --- Cambiar la cajera (o la nota) de una foto ya registrada ---------------
// Reasigna también sus billetes: si la foto era de otra cajera, todo lo que
// salga en ella lo es.
router.patch('/:id', requiereSesion, async (req, res, next) => {
  try {
    const captura = await unaFila('SELECT * FROM capturas WHERE id = $1', [Number(req.params.id) || 0]);
    if (!captura) return res.status(404).json({ error: 'Captura no encontrada.' });

    const cajeraId = req.body.cajera_id !== undefined ? Number(req.body.cajera_id) : captura.cajera_id;
    if (!(await unaFila('SELECT 1 FROM cajeras WHERE id = $1', [cajeraId]))) {
      return res.status(400).json({ error: 'Cajera no válida.' });
    }

    const nota = req.body.nota !== undefined ? String(req.body.nota).trim() || null : captura.nota;

    await enTransaccion(async (cliente) => {
      await cliente.query('UPDATE capturas SET cajera_id = $1, nota = $2 WHERE id = $3', [cajeraId, nota, captura.id]);
      await cliente.query('UPDATE billetes SET cajera_id = $1 WHERE captura_id = $2', [cajeraId, captura.id]);
    });

    res.json({ captura: await capturaCompleta(captura.id) });
  } catch (err) {
    next(err);
  }
});

// --- Listado de capturas, de la más reciente a la más antigua -------------
// Admite filtrar por fechas y por cajera, y paginar con `offset`.
router.get('/', requiereSesion, async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const condiciones = [];
    const valores = [];
    const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

    const desde = fecha(req.query.desde);
    if (desde) { valores.push(desde); condiciones.push(`cap.recibida_en >= $${valores.length}::date`); }

    const hasta = fecha(req.query.hasta);
    if (hasta) { valores.push(hasta); condiciones.push(`cap.recibida_en < ($${valores.length}::date + 1)`); }

    if (Number(req.query.cajera_id)) {
      valores.push(Number(req.query.cajera_id));
      condiciones.push(`cap.cajera_id = $${valores.length}`);
    }
    const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    // Se pide una de más para saber si quedan más páginas sin contarlas todas.
    valores.push(limite + 1, offset);
    const filas = await consultar(
      `SELECT cap.id, cap.archivo, cap.miniatura, cap.estado, cap.nota, cap.recibida_en,
              c.nombre AS cajera,
              (SELECT COUNT(*)::int FROM billetes b WHERE b.captura_id = cap.id) AS n_billetes,
              (SELECT COALESCE(SUM(b.denominacion), 0)::int FROM billetes b WHERE b.captura_id = cap.id) AS monto
         FROM capturas cap JOIN cajeras c ON c.id = cap.cajera_id
         ${donde}
        ORDER BY cap.recibida_en DESC, cap.id DESC
        LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
      valores
    );

    const hayMas = filas.length > limite;
    res.json({ capturas: await conFotos(filas.slice(0, limite)), hay_mas: hayMas });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requiereSesion, async (req, res, next) => {
  try {
    const captura = await capturaCompleta(Number(req.params.id) || 0);
    if (!captura) return res.status(404).json({ error: 'Captura no encontrada.' });
    res.json({ captura });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, capturaCompleta };

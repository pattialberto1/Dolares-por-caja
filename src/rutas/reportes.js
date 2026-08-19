'use strict';

const express = require('express');
const { consultar, unaFila } = require('../db');
const { requiereSesion } = require('../auth');

const router = express.Router();

function rango(req) {
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : '1970-01-01';
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : '2999-12-31';
  return { desde, hasta };
}

// El rango se compara como [desde, hasta+1día) para incluir el último día entero.
const ENTRE = `>= $1::date AND %COL% < ($2::date + 1)`;

// --- Resumen por cajera ----------------------------------------------------
router.get('/resumen', requiereSesion, async (req, res, next) => {
  try {
    const { desde, hasta } = rango(req);
    const v = [desde, hasta];

    const porCajera = await consultar(
      `SELECT c.id, c.nombre,
              COUNT(b.id)::int AS billetes,
              COALESCE(SUM(b.denominacion), 0)::int AS monto,
              COUNT(*) FILTER (WHERE b.id IS NOT NULL AND
                    (b.confianza IS DISTINCT FROM 'alta' OR b.serial_norm LIKE '%?%'))::int AS por_revisar
         FROM cajeras c
    LEFT JOIN billetes b ON b.cajera_id = c.id
          AND b.creado_en ${ENTRE.replace('%COL%', 'b.creado_en')}
        GROUP BY c.id, c.nombre ORDER BY monto DESC, c.nombre`,
      v
    );

    const porDenominacion = await consultar(
      `SELECT denominacion, COUNT(*)::int AS cantidad
         FROM billetes
        WHERE denominacion IS NOT NULL AND creado_en ${ENTRE.replace('%COL%', 'creado_en')}
        GROUP BY denominacion ORDER BY denominacion`,
      v
    );

    const porDia = await consultar(
      `SELECT to_char(creado_en, 'YYYY-MM-DD') AS dia,
              COUNT(*)::int AS billetes, COALESCE(SUM(denominacion), 0)::int AS monto
         FROM billetes WHERE creado_en ${ENTRE.replace('%COL%', 'creado_en')}
        GROUP BY 1 ORDER BY 1 DESC LIMIT 60`,
      v
    );

    const totales = await unaFila(
      `SELECT COUNT(*)::int AS billetes, COALESCE(SUM(denominacion), 0)::int AS monto
         FROM billetes WHERE creado_en ${ENTRE.replace('%COL%', 'creado_en')}`,
      v
    );

    const gasto = await unaFila(
      `SELECT COUNT(*)::int AS fotos, COALESCE(SUM(costo_usd), 0)::float8 AS costo_usd
         FROM capturas WHERE recibida_en ${ENTRE.replace('%COL%', 'recibida_en')}`,
      v
    );

    res.json({ desde, hasta, totales, gasto, por_cajera: porCajera, por_denominacion: porDenominacion, por_dia: porDia });
  } catch (err) {
    next(err);
  }
});

// --- Exportar a CSV (se abre en Excel) -------------------------------------
router.get('/exportar.csv', requiereSesion, async (req, res, next) => {
  try {
    const { desde, hasta } = rango(req);
    const filas = await consultar(
      `SELECT to_char(b.creado_en, 'YYYY-MM-DD HH24:MI') AS fecha, c.nombre AS cajera,
              b.serial, b.denominacion, b.serie, b.letra_distrito AS distrito,
              b.confianza, b.verificado, b.observaciones, cap.nota
         FROM billetes b
         JOIN cajeras c ON c.id = b.cajera_id
         JOIN capturas cap ON cap.id = b.captura_id
        WHERE b.creado_en ${ENTRE.replace('%COL%', 'b.creado_en')}
        ORDER BY b.creado_en DESC`,
      [desde, hasta]
    );

    const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const cabecera = ['fecha', 'cajera', 'serial', 'denominacion', 'serie', 'distrito', 'confianza', 'verificado', 'observaciones', 'nota'];
    const csv = [cabecera.join(','), ...filas.map((f) => cabecera.map((c) => escapar(f[c])).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dolares_${desde}_${hasta}.csv"`);
    res.send('﻿' + csv); // BOM para que Excel respete los acentos
  } catch (err) {
    next(err);
  }
});

module.exports = router;

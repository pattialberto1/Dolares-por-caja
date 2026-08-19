'use strict';

const express = require('express');
const { db } = require('../db');
const { requiereSesion } = require('../auth');

const router = express.Router();

function rango(req) {
  const desde = req.query.desde || '1970-01-01';
  const hasta = req.query.hasta || '2999-12-31';
  return { desde, hasta: `${hasta} 23:59:59` };
}

// --- Resumen por cajera ----------------------------------------------------
router.get('/resumen', requiereSesion, (req, res) => {
  const { desde, hasta } = rango(req);

  const porCajera = db
    .prepare(
      `SELECT c.id, c.nombre,
              COUNT(b.id) AS billetes,
              COALESCE(SUM(b.denominacion), 0) AS monto,
              SUM(CASE WHEN b.confianza <> 'alta' OR b.serial_norm LIKE '%?%' THEN 1 ELSE 0 END) AS por_revisar
         FROM cajeras c
    LEFT JOIN billetes b ON b.cajera_id = c.id AND b.creado_en BETWEEN ? AND ?
        GROUP BY c.id ORDER BY monto DESC`
    )
    .all(desde, hasta);

  const porDenominacion = db
    .prepare(
      `SELECT denominacion, COUNT(*) AS cantidad
         FROM billetes WHERE creado_en BETWEEN ? AND ? AND denominacion IS NOT NULL
        GROUP BY denominacion ORDER BY denominacion`
    )
    .all(desde, hasta);

  const porDia = db
    .prepare(
      `SELECT date(creado_en) AS dia, COUNT(*) AS billetes, COALESCE(SUM(denominacion), 0) AS monto
         FROM billetes WHERE creado_en BETWEEN ? AND ?
        GROUP BY dia ORDER BY dia DESC LIMIT 60`
    )
    .all(desde, hasta);

  const totales = db
    .prepare(
      `SELECT COUNT(*) AS billetes, COALESCE(SUM(denominacion), 0) AS monto
         FROM billetes WHERE creado_en BETWEEN ? AND ?`
    )
    .get(desde, hasta);

  const gasto = db
    .prepare(
      `SELECT COUNT(*) AS fotos, COALESCE(SUM(costo_usd), 0) AS costo_usd
         FROM capturas WHERE recibida_en BETWEEN ? AND ?`
    )
    .get(desde, hasta);

  res.json({ desde, hasta, totales, gasto, por_cajera: porCajera, por_denominacion: porDenominacion, por_dia: porDia });
});

// --- Exportar a CSV (se abre en Excel) -------------------------------------
router.get('/exportar.csv', requiereSesion, (req, res) => {
  const { desde, hasta } = rango(req);
  const filas = db
    .prepare(
      `SELECT b.creado_en, c.nombre AS cajera, b.serial, b.denominacion, b.serie,
              b.letra_distrito, b.confianza, b.verificado, b.observaciones,
              cap.nota, cap.archivo
         FROM billetes b
         JOIN cajeras c ON c.id = b.cajera_id
         JOIN capturas cap ON cap.id = b.captura_id
        WHERE b.creado_en BETWEEN ? AND ?
        ORDER BY b.creado_en DESC`
    )
    .all(desde, hasta);

  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cabecera = [
    'fecha', 'cajera', 'serial', 'denominacion', 'serie', 'distrito',
    'confianza', 'verificado', 'observaciones', 'nota', 'foto',
  ];
  const csv = [
    cabecera.join(','),
    ...filas.map((f) => Object.values(f).map(escapar).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dolares_${desde}_${req.query.hasta || 'hoy'}.csv"`);
  res.send('﻿' + csv); // BOM para que Excel respete los acentos
});

module.exports = router;

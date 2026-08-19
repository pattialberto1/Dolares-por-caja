'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DIR_DATOS = process.env.DIR_DATOS
  ? path.resolve(process.env.DIR_DATOS)
  : path.join(__dirname, '..', 'datos');
const DIR_FOTOS = path.join(DIR_DATOS, 'fotos');

fs.mkdirSync(DIR_FOTOS, { recursive: true });

const db = new Database(path.join(DIR_DATOS, 'dolares.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS cajeras (
  id         INTEGER PRIMARY KEY,
  nombre     TEXT NOT NULL UNIQUE,
  activa     INTEGER NOT NULL DEFAULT 1,
  creada_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id         INTEGER PRIMARY KEY,
  nombre     TEXT NOT NULL UNIQUE,
  pin_hash   TEXT NOT NULL,
  rol        TEXT NOT NULL DEFAULT 'operador',   -- 'admin' | 'operador'
  cajera_id  INTEGER REFERENCES cajeras(id),
  activo     INTEGER NOT NULL DEFAULT 1,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sesiones (
  token       TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada_en   TEXT NOT NULL DEFAULT (datetime('now')),
  expira_en   TEXT NOT NULL
);

-- Una captura = una foto subida (puede contener varios billetes).
CREATE TABLE IF NOT EXISTS capturas (
  id            INTEGER PRIMARY KEY,
  archivo       TEXT NOT NULL,
  miniatura     TEXT,
  hash_foto     TEXT NOT NULL,
  cajera_id     INTEGER NOT NULL REFERENCES cajeras(id),
  usuario_id    INTEGER REFERENCES usuarios(id),
  nota          TEXT,
  estado        TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|procesada|error|revisar
  error         TEXT,
  modelo        TEXT,
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  costo_usd     REAL DEFAULT 0,
  recibida_en   TEXT NOT NULL DEFAULT (datetime('now')),
  procesada_en  TEXT
);

CREATE TABLE IF NOT EXISTS billetes (
  id             INTEGER PRIMARY KEY,
  captura_id     INTEGER NOT NULL REFERENCES capturas(id) ON DELETE CASCADE,
  cajera_id      INTEGER NOT NULL REFERENCES cajeras(id),
  serial         TEXT NOT NULL,          -- tal como se lee: "MB 12345678 A"
  serial_norm    TEXT NOT NULL,          -- normalizado: "MB12345678A"
  denominacion   INTEGER,
  serie          TEXT,                   -- año de serie, ej "2017A"
  letra_distrito TEXT,
  confianza      TEXT,                   -- alta|media|baja
  observaciones  TEXT,
  verificado     INTEGER NOT NULL DEFAULT 0,
  duplicado_de   INTEGER REFERENCES billetes(id),
  creado_en      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_billetes_serial   ON billetes(serial_norm);
CREATE INDEX IF NOT EXISTS idx_billetes_cajera   ON billetes(cajera_id);
CREATE INDEX IF NOT EXISTS idx_billetes_fecha    ON billetes(creado_en);
CREATE UNIQUE INDEX IF NOT EXISTS idx_capturas_hash ON capturas(hash_foto);
`);

/** Normaliza un serial para búsqueda: mayúsculas, sin espacios ni signos. */
function normalizarSerial(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

module.exports = { db, DIR_DATOS, DIR_FOTOS, normalizarSerial };

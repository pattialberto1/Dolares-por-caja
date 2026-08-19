-- Esquema de "Dólares por caja".
-- La app lo crea sola en el primer arranque; este archivo está aquí para que
-- puedas revisarlo o aplicarlo a mano desde el editor SQL de Supabase.

CREATE TABLE IF NOT EXISTS cajeras (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre     text NOT NULL UNIQUE,
  activa     boolean NOT NULL DEFAULT true,
  creada_en  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre     text NOT NULL UNIQUE,
  pin_hash   text NOT NULL,
  rol        text NOT NULL DEFAULT 'operador',
  cajera_id  bigint REFERENCES cajeras(id),
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sesiones (
  token       text PRIMARY KEY,
  usuario_id  bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada_en   timestamptz NOT NULL DEFAULT now(),
  expira_en   timestamptz NOT NULL
);

-- Una captura = una foto subida (puede contener varios billetes).
CREATE TABLE IF NOT EXISTS capturas (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  archivo       text NOT NULL,
  miniatura     text,
  hash_foto     text NOT NULL UNIQUE,
  cajera_id     bigint NOT NULL REFERENCES cajeras(id),
  usuario_id    bigint REFERENCES usuarios(id),
  nota          text,
  estado        text NOT NULL DEFAULT 'pendiente',
  error         text,
  modelo        text,
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_out    integer NOT NULL DEFAULT 0,
  costo_usd     numeric(10,6) NOT NULL DEFAULT 0,
  recibida_en   timestamptz NOT NULL DEFAULT now(),
  procesada_en  timestamptz
);

CREATE TABLE IF NOT EXISTS billetes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  captura_id     bigint NOT NULL REFERENCES capturas(id) ON DELETE CASCADE,
  cajera_id      bigint NOT NULL REFERENCES cajeras(id),
  serial         text NOT NULL,
  serial_norm    text NOT NULL,
  denominacion   integer,
  serie          text,
  letra_distrito text,
  confianza      text,
  observaciones  text,
  verificado     boolean NOT NULL DEFAULT false,
  duplicado_de   bigint REFERENCES billetes(id) ON DELETE SET NULL,
  creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billetes_serial ON billetes (serial_norm);
CREATE INDEX IF NOT EXISTS idx_billetes_cajera ON billetes (cajera_id);
CREATE INDEX IF NOT EXISTS idx_billetes_fecha  ON billetes (creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_sesiones_expira ON sesiones (expira_en);
-- Para que buscar un pedazo del serial (LIKE '%1234%') no recorra toda la tabla.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_billetes_serial_trgm ON billetes USING gin (serial_norm gin_trgm_ops);

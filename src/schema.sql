CREATE TABLE IF NOT EXISTS cop_units (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  city TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cop_dvrs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id BIGINT NOT NULL REFERENCES cop_units(id),
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  cloud_serial TEXT,
  host TEXT,
  http_port INTEGER NOT NULL DEFAULT 80 CHECK (http_port BETWEEN 1 AND 65535),
  access_mode TEXT NOT NULL DEFAULT 'agent' CHECK (access_mode IN ('agent', 'vpn')),
  connector_id TEXT,
  secret_ref TEXT,
  channel_count INTEGER NOT NULL CHECK (channel_count BETWEEN 1 AND 32),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS cloud_serial TEXT;
CREATE TABLE IF NOT EXISTS cop_cameras (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dvr_id BIGINT NOT NULL REFERENCES cop_dvrs(id),
  channel INTEGER NOT NULL CHECK (channel BETWEEN 1 AND 32),
  name TEXT NOT NULL,
  area TEXT,
  policy JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dvr_id, channel)
);
CREATE INDEX IF NOT EXISTS cop_dvrs_unit_idx ON cop_dvrs(unit_id);
CREATE INDEX IF NOT EXISTS cop_cameras_dvr_idx ON cop_cameras(dvr_id);

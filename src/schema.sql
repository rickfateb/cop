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
  access_mode TEXT NOT NULL DEFAULT 'sftp_push',
  connector_id TEXT,
  secret_ref TEXT,
  channel_count INTEGER NOT NULL CHECK (channel_count BETWEEN 1 AND 32),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS cloud_serial TEXT;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS ingest_key TEXT;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS rtsp_port INTEGER NOT NULL DEFAULT 554;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS service_port INTEGER NOT NULL DEFAULT 37777;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS remote_connection_mode TEXT;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS access_username TEXT;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS last_ingest_at TIMESTAMPTZ;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS last_ingest_path TEXT;
ALTER TABLE cop_dvrs DROP CONSTRAINT IF EXISTS cop_dvrs_access_mode_check;
ALTER TABLE cop_dvrs ADD CONSTRAINT cop_dvrs_access_mode_check
  CHECK (access_mode IN ('sftp_push','ftp_push','direct_http','intelbras_cloud','agent','vpn'));
ALTER TABLE cop_dvrs DROP CONSTRAINT IF EXISTS cop_dvrs_rtsp_port_check;
ALTER TABLE cop_dvrs ADD CONSTRAINT cop_dvrs_rtsp_port_check CHECK (rtsp_port BETWEEN 1 AND 65535);
ALTER TABLE cop_dvrs DROP CONSTRAINT IF EXISTS cop_dvrs_service_port_check;
ALTER TABLE cop_dvrs ADD CONSTRAINT cop_dvrs_service_port_check CHECK (service_port BETWEEN 1 AND 65535);
ALTER TABLE cop_dvrs DROP CONSTRAINT IF EXISTS cop_dvrs_remote_connection_mode_check;
ALTER TABLE cop_dvrs ADD CONSTRAINT cop_dvrs_remote_connection_mode_check
  CHECK (remote_connection_mode IS NULL OR remote_connection_mode IN ('cloud','domain','ip','ip_extra'));

UPDATE cop_dvrs
SET ingest_key = lower(substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 12))
WHERE ingest_key IS NULL OR ingest_key = '';
CREATE UNIQUE INDEX IF NOT EXISTS cop_dvrs_ingest_key_uq ON cop_dvrs(ingest_key);

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

CREATE TABLE IF NOT EXISTS cop_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id BIGINT NOT NULL REFERENCES cop_units(id),
  dvr_id BIGINT NOT NULL REFERENCES cop_dvrs(id),
  camera_id BIGINT REFERENCES cop_cameras(id),
  detected_channel INTEGER,
  stream_key TEXT,
  source TEXT NOT NULL DEFAULT 'sftp' CHECK (source IN ('sftp','ftp','http','rtsp','cloud','manual')),
  status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','ready','processed','ignored','error')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_frame_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  media_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cop_media (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES cop_events(id) ON DELETE CASCADE,
  unit_id BIGINT NOT NULL REFERENCES cop_units(id),
  dvr_id BIGINT NOT NULL REFERENCES cop_dvrs(id),
  camera_id BIGINT REFERENCES cop_cameras(id),
  detected_channel INTEGER,
  stream_key TEXT,
  source TEXT NOT NULL DEFAULT 'sftp',
  source_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL,
  data BYTEA NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  selected_for_ai BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS cop_analysis_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL UNIQUE REFERENCES cop_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  not_before TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cop_ingest_errors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dvr_id BIGINT REFERENCES cop_dvrs(id),
  source_path TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cop_cameras ADD COLUMN IF NOT EXISTS device_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE cop_cameras ADD COLUMN IF NOT EXISTS device_config_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE cop_cameras DROP CONSTRAINT IF EXISTS cop_cameras_device_config_status_check;
ALTER TABLE cop_cameras ADD CONSTRAINT cop_cameras_device_config_status_check
  CHECK (device_config_status IN ('pending','confirmed','unsupported','error'));

CREATE INDEX IF NOT EXISTS cop_dvrs_unit_idx ON cop_dvrs(unit_id);
CREATE INDEX IF NOT EXISTS cop_cameras_dvr_idx ON cop_cameras(dvr_id);
CREATE INDEX IF NOT EXISTS cop_events_dvr_time_idx ON cop_events(dvr_id, last_frame_at DESC);
CREATE INDEX IF NOT EXISTS cop_events_camera_time_idx ON cop_events(camera_id, last_frame_at DESC);
CREATE INDEX IF NOT EXISTS cop_media_received_idx ON cop_media(received_at DESC);
CREATE INDEX IF NOT EXISTS cop_media_event_idx ON cop_media(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS cop_media_source_sha_uq ON cop_media(dvr_id, source_path, sha256);
CREATE INDEX IF NOT EXISTS cop_analysis_pending_idx ON cop_analysis_jobs(status, not_before);

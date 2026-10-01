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


ALTER TABLE cop_media ADD COLUMN IF NOT EXISTS frame_offset_seconds INTEGER;
ALTER TABLE cop_analysis_jobs ADD COLUMN IF NOT EXISTS provider_audit_id TEXT;
ALTER TABLE cop_analysis_jobs ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE cop_analysis_jobs ADD COLUMN IF NOT EXISTS result_checked_at TIMESTAMPTZ;
ALTER TABLE cop_analysis_jobs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS cop_fraud_incidents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL UNIQUE REFERENCES cop_events(id) ON DELETE CASCADE,
  unit_id BIGINT NOT NULL REFERENCES cop_units(id),
  dvr_id BIGINT NOT NULL REFERENCES cop_dvrs(id),
  camera_id BIGINT REFERENCES cop_cameras(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  classification TEXT NOT NULL CHECK(classification='Grave - Fraude'),
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence NUMERIC NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  video_media_id BIGINT REFERENCES cop_media(id),
  alert_status TEXT NOT NULL DEFAULT 'pending' CHECK(alert_status IN ('pending','sending','sent','failed')),
  alert_attempts INTEGER NOT NULL DEFAULT 0,
  last_alert_attempt_at TIMESTAMPTZ,
  last_alert_error TEXT,
  alert_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cop_fraud_evidence (
  incident_id BIGINT NOT NULL REFERENCES cop_fraud_incidents(id) ON DELETE CASCADE,
  media_id BIGINT NOT NULL REFERENCES cop_media(id),
  evidence_order INTEGER NOT NULL CHECK(evidence_order BETWEEN 1 AND 5),
  PRIMARY KEY(incident_id,evidence_order),
  UNIQUE(incident_id,media_id)
);

CREATE INDEX IF NOT EXISTS cop_fraud_incidents_pending_idx ON cop_fraud_incidents(alert_status,occurred_at);
CREATE INDEX IF NOT EXISTS cop_fraud_incidents_unit_idx ON cop_fraud_incidents(unit_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS cop_fraud_evidence_incident_idx ON cop_fraud_evidence(incident_id,evidence_order);


CREATE TABLE IF NOT EXISTS cop_investigations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id BIGINT NOT NULL REFERENCES cop_units(id),
  dvr_id BIGINT NOT NULL REFERENCES cop_dvrs(id),
  reference_at TIMESTAMPTZ NOT NULL,
  window_before_seconds INTEGER NOT NULL DEFAULT 300 CHECK(window_before_seconds BETWEEN 0 AND 3600),
  window_after_seconds INTEGER NOT NULL DEFAULT 600 CHECK(window_after_seconds BETWEEN 0 AND 3600),
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','api','financial','stock','other')),
  external_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','waiting_connector','retrieving','ready','analyzing','completed','partial','failed','cancelled')),
  connector_status TEXT NOT NULL DEFAULT 'not_available' CHECK(connector_status IN ('not_available','queued','running','done','partial','failed')),
  requested_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cop_investigation_channels (
  investigation_id BIGINT NOT NULL REFERENCES cop_investigations(id) ON DELETE CASCADE,
  camera_id BIGINT NOT NULL REFERENCES cop_cameras(id),
  channel INTEGER NOT NULL CHECK(channel BETWEEN 1 AND 32),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','waiting_connector','retrieving','ready','failed','unavailable')),
  requested_start_at TIMESTAMPTZ NOT NULL,
  requested_end_at TIMESTAMPTZ NOT NULL,
  retrieved_media_id BIGINT REFERENCES cop_media(id),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(investigation_id,camera_id)
);

CREATE INDEX IF NOT EXISTS cop_investigations_unit_time_idx ON cop_investigations(unit_id,reference_at DESC);
CREATE INDEX IF NOT EXISTS cop_investigations_status_idx ON cop_investigations(status,created_at);
CREATE INDEX IF NOT EXISTS cop_investigation_channels_status_idx ON cop_investigation_channels(status,investigation_id);

ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS playback_mode TEXT NOT NULL DEFAULT 'unavailable';
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS playback_host TEXT;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS playback_rtsp_port INTEGER;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS playback_username TEXT;
ALTER TABLE cop_dvrs ADD COLUMN IF NOT EXISTS playback_password_ref TEXT;
ALTER TABLE cop_dvrs DROP CONSTRAINT IF EXISTS cop_dvrs_playback_mode_check;
ALTER TABLE cop_dvrs ADD CONSTRAINT cop_dvrs_playback_mode_check CHECK(playback_mode IN ('unavailable','rtsp_direct','agent','cloud'));

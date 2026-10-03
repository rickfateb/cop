-- Holds have no automatic expiry. Releasing one requires recorded user consent.
CREATE TABLE IF NOT EXISTS cop_media_preservation_holds (
 media_id BIGINT PRIMARY KEY REFERENCES cop_media(id) ON DELETE CASCADE,
 reason TEXT NOT NULL,
 requested_by TEXT NOT NULL,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 released_at TIMESTAMPTZ,
 released_by TEXT,
 release_consent TEXT,
 CHECK (released_at IS NULL OR (released_by IS NOT NULL AND release_consent IS NOT NULL AND length(trim(release_consent)) > 0))
);
CREATE TABLE IF NOT EXISTS cop_capture_analysis_sequences (
 capture_id BIGINT NOT NULL REFERENCES cop_capture_requests(id),
 camera_id BIGINT NOT NULL,
 first_sample_at TIMESTAMPTZ NOT NULL,
 event_id BIGINT NOT NULL UNIQUE REFERENCES cop_events(id),
 PRIMARY KEY(capture_id,camera_id,first_sample_at),
 FOREIGN KEY(capture_id,camera_id) REFERENCES cop_capture_channels(capture_id,camera_id)
);
CREATE OR REPLACE FUNCTION cop_protect_preserved_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM cop_media_preservation_holds WHERE media_id=OLD.id AND released_at IS NULL) THEN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Original preservado: exclusao exige consentimento do usuario.' USING ERRCODE='P0001';
  END IF;
  IF NEW.data IS DISTINCT FROM OLD.data OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.bytes IS DISTINCT FROM OLD.bytes THEN
   RAISE EXCEPTION 'Original preservado: alteracao ou limpeza exige consentimento do usuario.' USING ERRCODE='P0001';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cop_preserved_media_guard ON cop_media;
CREATE TRIGGER cop_preserved_media_guard BEFORE DELETE OR UPDATE OF data,sha256,bytes ON cop_media
 FOR EACH ROW EXECUTE FUNCTION cop_protect_preserved_media();

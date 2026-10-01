import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const imageTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'], ['.gif', 'image/gif']
]);
const videoTypes = new Map([
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.avi', 'video/x-msvideo'],
  ['.dav', 'application/octet-stream'], ['.h264', 'video/h264'], ['.264', 'video/h264']
]);

export function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return imageTypes.get(ext) || videoTypes.get(ext) || 'application/octet-stream';
}

export function detectChannel(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  const patterns = [
    /(?:^|[/_.\- ])(?:channel|canal|camera|cam|ch)[ _.-]*0*(\d{1,2})(?=$|[/_.\- ])/i,
    /(?:^|[/_.\- ])chn[ _.-]*0*(\d{1,2})(?=$|[/_.\- ])/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const channel = Number(match[1]);
      if (channel >= 1 && channel <= 32) return channel;
    }
  }
  return null;
}

async function walk(dir, output = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return output; throw error; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, output);
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

function safeInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function startIngestWorker({ pool, root = process.env.COP_INGEST_ROOT || '/data/sftp/incoming', logger = console } = {}) {
  if (!pool) throw Error('Pool PostgreSQL obrigatório para ingestão.');
  const pollMs = safeInt(process.env.COP_INGEST_POLL_MS, 2500, 1000, 60000);
  const eventGapSeconds = safeInt(process.env.COP_EVENT_GAP_SECONDS, 35, 5, 600);
  const maxBytes = safeInt(process.env.COP_MAX_MEDIA_BYTES, 12 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
  const stable = new Map();
  const state = { ok: true, running: false, last_scan_at: null, last_error: null, processed_files: 0, rejected_files: 0 };
  let timer;
  let stopped = false;

  const reject = async (file, dvrId, sourcePath, reason) => {
    try {
      await pool.query('INSERT INTO cop_ingest_errors(dvr_id,source_path,reason) VALUES($1,$2,$3)', [dvrId || null, sourcePath || null, String(reason).slice(0, 500)]);
      const rejectedRoot = path.resolve(root, '..', 'rejected');
      await mkdir(rejectedRoot, { recursive: true });
      const target = path.join(rejectedRoot, `${Date.now()}-${path.basename(file)}`);
      await rename(file, target).catch(async () => unlink(file));
      state.rejected_files++;
    } catch (error) { logger.error('Falha ao mover arquivo rejeitado:', error.message); }
  };

  const findEvent = async ({ unitId, dvrId, cameraId, channel, streamKey }) => {
    const threshold = new Date(Date.now() - eventGapSeconds * 1000);
    const current = await pool.query(`
      SELECT id FROM cop_events
      WHERE dvr_id=$1
        AND camera_id IS NOT DISTINCT FROM $2
        AND detected_channel IS NOT DISTINCT FROM $3
        AND stream_key IS NOT DISTINCT FROM $4
        AND status='collecting' AND last_frame_at >= $5
      ORDER BY last_frame_at DESC LIMIT 1`, [dvrId, cameraId, channel, streamKey, threshold]);
    if (current.rowCount) return current.rows[0].id;
    const created = await pool.query(`
      INSERT INTO cop_events(unit_id,dvr_id,camera_id,detected_channel,stream_key,source)
      VALUES($1,$2,$3,$4,$5,'sftp') RETURNING id`, [unitId, dvrId, cameraId, channel, streamKey]);
    return created.rows[0].id;
  };

  const processFile = async (file, dvrMap) => {
    const relative = path.relative(root, file);
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length < 2) return;
    const ingestKey = parts[0].toLowerCase();
    const dvr = dvrMap.get(ingestKey);
    if (!dvr) return;
    const info = await stat(file);
    if (info.size > maxBytes) return reject(file, dvr.id, relative, `Arquivo acima do limite de ${maxBytes} bytes.`);
    if (info.size === 0) return;

    const payload = await readFile(file);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const channel = detectChannel(relative);
    let cameraId = null;
    let retentionDays = 7;
    if (channel) {
      const camera = await pool.query('SELECT id, policy FROM cop_cameras WHERE dvr_id=$1 AND channel=$2 AND active=TRUE', [dvr.id, channel]);
      if (camera.rowCount) {
        cameraId = camera.rows[0].id;
        const retention = Number(camera.rows[0].policy?.retention_days);
        if (Number.isInteger(retention) && retention >= 1 && retention <= 365) retentionDays = retention;
      }
    }
    const streamKey = parts.length > 2 ? parts.slice(1, -1).join('/').slice(0, 240) || null : null;
    const eventId = await findEvent({ unitId: dvr.unit_id, dvrId: dvr.id, cameraId, channel, streamKey });
    const expiresAt = new Date(Date.now() + retentionDays * 86400000);
    const inserted = await pool.query(`
      INSERT INTO cop_media(event_id,unit_id,dvr_id,camera_id,detected_channel,stream_key,source,source_path,filename,content_type,bytes,sha256,data,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'sftp',$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (dvr_id,source_path,sha256) DO NOTHING RETURNING id`,
      [eventId, dvr.unit_id, dvr.id, cameraId, channel, streamKey, relative, path.basename(file), contentTypeFor(file), payload.length, sha256, payload, expiresAt]);

    if (inserted.rowCount) {
      await Promise.all([
        pool.query('UPDATE cop_events SET last_frame_at=now(),media_count=media_count+1,updated_at=now() WHERE id=$1', [eventId]),
        pool.query('UPDATE cop_dvrs SET last_ingest_at=now(),last_ingest_path=$1,updated_at=now() WHERE id=$2', [relative.slice(0, 1000), dvr.id])
      ]);
      state.processed_files++;
    }
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };

  const finalizeEvents = async () => {
    const threshold = new Date(Date.now() - eventGapSeconds * 1000);
    await pool.query("UPDATE cop_events SET status='ready',updated_at=now() WHERE status='collecting' AND last_frame_at < $1", [threshold]);
    await pool.query(`
      INSERT INTO cop_analysis_jobs(event_id,status,not_before)
      SELECT e.id,'pending',
        CASE WHEN c.policy->>'analysis_mode'='duration'
          THEN e.started_at + make_interval(secs => COALESCE((c.policy->>'analysis_after_seconds')::int,0))
          ELSE now() END
      FROM cop_events e
      JOIN cop_cameras c ON c.id=e.camera_id
      WHERE e.status='ready' AND c.active=TRUE AND c.policy->>'enabled'='true'
        AND c.policy->>'analysis_mode' IN ('always','duration')
      ON CONFLICT(event_id) DO NOTHING`);
    await pool.query('DELETE FROM cop_media WHERE expires_at < now()');
  };

  const scan = async () => {
    if (state.running || stopped) return;
    state.running = true;
    try {
      await mkdir(root, { recursive: true });
      const rows = await pool.query("SELECT id,unit_id,lower(ingest_key) AS ingest_key FROM cop_dvrs WHERE active=TRUE AND ingest_key IS NOT NULL");
      const dvrMap = new Map(rows.rows.map(row => [row.ingest_key, row]));
      const files = await walk(root);
      const seen = new Set(files);
      for (const file of files) {
        const info = await stat(file);
        const signature = `${info.size}:${info.mtimeMs}`;
        const previous = stable.get(file);
        if (!previous || previous.signature !== signature) {
          stable.set(file, { signature, count: 0 });
          continue;
        }
        previous.count++;
        if (previous.count < 1 || Date.now() - info.mtimeMs < 1200) continue;
        try { await processFile(file, dvrMap); }
        catch (error) {
          state.ok = false; state.last_error = error.message;
          logger.error('Falha na ingestão:', relativeSafe(root, file), error.message);
        } finally { stable.delete(file); }
      }
      for (const key of stable.keys()) if (!seen.has(key)) stable.delete(key);
      await finalizeEvents();
      state.ok = true; state.last_error = null; state.last_scan_at = new Date().toISOString();
    } catch (error) {
      state.ok = false; state.last_error = error.message; state.last_scan_at = new Date().toISOString();
      logger.error('Falha no scanner SFTP:', error.message);
    } finally {
      state.running = false;
      if (!stopped) timer = setTimeout(scan, pollMs);
    }
  };

  mkdir(root, { recursive: true }).then(scan).catch(error => {
    state.ok = false; state.last_error = error.message; logger.error(error.message);
  });
  return {
    state,
    stop() { stopped = true; if (timer) clearTimeout(timer); }
  };
}

function relativeSafe(root, file) {
  const value = path.relative(root, file);
  return value.startsWith('..') ? path.basename(file) : value;
}

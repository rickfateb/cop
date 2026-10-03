const fail = message => Object.assign(Error(message), {status: 400});
const modes = ['continuous', 'motion', 'ai'];
const mediaTypes = ['photo', 'video', 'all'];
function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw fail(label + ' inválido.');
  return number;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw fail(label + ' inválida; informe o fuso horário.');
  const local = value.slice(0, 19), date = new Date(local + 'Z');
  const instant = new Date(value);
  if (!Number.isFinite(+instant) || !Number.isFinite(+date) || date.toISOString().slice(0, 19) !== local) throw fail(label + ' inválida.');
  return instant.toISOString();
}
export function validateCapture(body) {
  const unitId = positiveId(body.unit_id, 'Unidade');
  const dvrId = positiveId(body.dvr_id, 'DVR');
  const start = timestamp(body.start_at, 'Data inicial');
  const end = timestamp(body.end_at, 'Data final');
  if (new Date(end) <= new Date(start)) throw fail('A data final deve ser posterior à data inicial.');
  if (!modes.includes(body.capture_mode)) throw fail('Tipo de captura inválido.');
  if (!mediaTypes.includes(body.media_type)) throw fail('Mídia inválida.');
  if (!Array.isArray(body.channels) || !body.channels.length || body.channels.length > 32) throw fail('Selecione pelo menos um canal.');
  const channels = [...new Set(body.channels.map(value => {
    const channel = positiveId(value, 'Canal');
    if (channel > 32) throw fail('Canal inválido.');
    return channel;
  }))].sort((a, b) => a - b);
  return {unitId, dvrId, start, end, channels, mode: body.capture_mode, mediaType: body.media_type};
}
export function capturePlan(request, dvr, now = new Date()) {
  if (request.mode !== 'continuous') return {supported: false, reason: request.mode === 'motion'
    ? 'Aguardando suporte do receptor à consulta dos eventos históricos de movimento detectados pelo DVR.'
    : 'Aguardando suporte do receptor à consulta dos eventos históricos de IA registrados pelo DVR.'};
  if (request.mediaType !== 'video') return {supported: false, reason: 'Aguardando suporte do receptor à recuperação de fotos históricas. Nenhum vídeo será baixado em substituição às fotos solicitadas.'};
  if (new Date(request.end) > now) return {supported: false, reason: 'Aguardando o término do período solicitado.'};
  if (new Date(request.end) - new Date(request.start) > 7200000) return {supported: false, reason: 'Aguardando suporte do receptor ao processamento de períodos maiores que 120 minutos.'};
  if (!['rtsp_direct', 'netsdk_autoregister'].includes(dvr.playback_mode)) return {supported: false, reason: 'Recuperação histórica não configurada para este DVR.'};
  return {supported: true, reason: null};
}
export async function createCapture(pool, body, actor = 'admin') {
  const request = validateCapture(body), client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dvr = (await client.query('SELECT id,playback_mode FROM cop_dvrs WHERE id=$1 AND unit_id=$2 AND active=TRUE', [request.dvrId, request.unitId])).rows[0];
    if (!dvr) throw fail('Selecione um DVR ativo da unidade informada.');
    const cameras = (await client.query('SELECT id,channel,policy,device_config FROM cop_cameras WHERE dvr_id=$1 AND active=TRUE AND channel=ANY($2::int[]) ORDER BY channel', [dvr.id, request.channels])).rows;
    if (cameras.length !== request.channels.length) throw fail('Um ou mais canais não estão ativos ou cadastrados neste DVR.');
    const plan = capturePlan(request, dvr);
    const saved = (await client.query(`INSERT INTO cop_capture_requests(unit_id,dvr_id,start_at,end_at,capture_mode,media_type,status,last_error,requested_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [request.unitId, dvr.id, request.start, request.end, request.mode, request.mediaType, plan.supported ? 'queued' : 'waiting_connector', plan.reason, actor])).rows[0];
    for (const camera of cameras) await client.query(`INSERT INTO cop_capture_channels(capture_id,camera_id,channel,sampling_config)
      VALUES($1,$2,$3,$4)`, [saved.id, camera.id, camera.channel, JSON.stringify({policy: camera.policy, device_config: camera.device_config})]);
    if (plan.supported) {
      const seconds = Math.ceil((new Date(request.end) - new Date(request.start)) / 1000);
      const before = Math.floor(seconds / 2), after = seconds - before;
      const reference = new Date(+new Date(request.start) + before * 1000);
      const investigation = (await client.query(`INSERT INTO cop_investigations(unit_id,dvr_id,reference_at,window_before_seconds,window_after_seconds,reason,source,external_ref,status,connector_status,requested_by)
        VALUES($1,$2,$3,$4,$5,$6,'other',$7,'waiting_connector','queued',$8) RETURNING id`, [request.unitId, dvr.id, reference, before, after, 'Captura por período · Modo Contínuo · Vídeo', 'capture:' + saved.id, actor])).rows[0];
      for (const camera of cameras) await client.query(`INSERT INTO cop_investigation_channels(investigation_id,camera_id,channel,status,requested_start_at,requested_end_at)
        VALUES($1,$2,$3,'waiting_connector',$4,$5)`, [investigation.id, camera.id, camera.channel, request.start, request.end]);
      await client.query('UPDATE cop_capture_requests SET investigation_id=$2 WHERE id=$1', [saved.id, investigation.id]);
      saved.investigation_id = investigation.id;
    }
    await client.query('COMMIT');
    return saved;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function listCaptures(pool, {limit = 100} = {}) {
  const rows = (await pool.query(`SELECT r.*,u.name unit_name,d.name dvr_name,
    COALESCE(i.status,r.status) effective_status,COALESCE(i.last_error,r.last_error) effective_error
    FROM cop_capture_requests r JOIN cop_units u ON u.id=r.unit_id JOIN cop_dvrs d ON d.id=r.dvr_id
    LEFT JOIN cop_investigations i ON i.id=r.investigation_id
    ORDER BY r.created_at DESC,r.id DESC LIMIT $1`, [Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 100))])).rows;
  if (!rows.length) return [];
  const channels = (await pool.query(`SELECT cc.*,c.name camera_name,ic.status,ic.last_error,ic.retrieved_media_id
    FROM cop_capture_channels cc JOIN cop_cameras c ON c.id=cc.camera_id
    JOIN cop_capture_requests r ON r.id=cc.capture_id
    LEFT JOIN cop_investigation_channels ic ON ic.investigation_id=r.investigation_id AND ic.camera_id=cc.camera_id
    WHERE cc.capture_id=ANY($1::bigint[]) ORDER BY cc.capture_id,cc.channel`, [rows.map(row => row.id)])).rows;
  return rows.map(row => ({...row, channels: channels.filter(channel => String(channel.capture_id) === String(row.id))}));
}

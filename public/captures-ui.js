const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const modeLabels = {continuous:'Modo Contínuo',motion:'Apenas movimento',ai:'IA'};
const mediaLabels = {photo:'Foto',video:'Vídeo',all:'Todos'};
const statusLabels = {queued:'Na fila',waiting_connector:'Aguardando conector',pending:'Na fila',retrieving:'Capturando',ready:'Disponível',partial:'Parcial',failed:'Falha',cancelled:'Cancelada',completed:'Concluída',analyzing:'Em análise'};
const displayDate = value => new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(value));
export function saoPauloInput(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p => [p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function buildCapturePayload(draft) {
  const convert = (value,label) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) throw Error('Informe a ' + label + '.');
    const date = new Date(value + ':00-03:00');
    if (!Number.isFinite(+date) || saoPauloInput(date) !== value) throw Error('Informe a ' + label + ' válida.');
    return date.toISOString();
  };
  const start = convert(draft.start,'data inicial'), end = convert(draft.end,'data final');
  if (new Date(end) <= new Date(start)) throw Error('A data final deve ser posterior à data inicial.');
  if (!draft.channels?.length) throw Error('Selecione pelo menos um canal.');
  return {unit_id:Number(draft.unitId),dvr_id:Number(draft.dvrId),start_at:start,end_at:end,
    channels:draft.channels.map(Number),capture_mode:draft.mode,media_type:draft.mediaType};
}
export function captureForm(data, draft = {}) {
  const units = data.units.filter(u => u.active), unit = units.find(u => String(u.id) === String(draft.unitId)) || units[0];
  const dvrs = data.dvrs.filter(d => d.active && String(d.unit_id) === String(unit?.id));
  const dvr = dvrs.find(d => String(d.id) === String(draft.dvrId)) || dvrs[0];
  const cameras = data.cameras.filter(c => c.active && String(c.dvr_id) === String(dvr?.id));
  const end = draft.end || saoPauloInput(), start = draft.start || end.slice(0,10) + 'T00:00';
  const mode = draft.mode || 'motion', media = draft.mediaType || 'photo';
  return `<form id="capture-form" class="investigation-form">
    <div class="field"><label for="capture-unit">Unidade</label><select id="capture-unit" name="unit_id" required>${units.map(u => `<option value="${u.id}" ${u.id===unit?.id?'selected':''}>${html(u.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="capture-dvr">DVR</label><select id="capture-dvr" name="dvr_id" required>${dvrs.map(d => `<option value="${d.id}" ${d.id===dvr?.id?'selected':''}>${html(d.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="capture-start">Data inicial · São Paulo</label><input id="capture-start" name="start_at" type="datetime-local" value="${html(start)}" required></div>
    <div class="field"><label for="capture-end">Data final · São Paulo</label><input id="capture-end" name="end_at" type="datetime-local" value="${html(end)}" required></div>
    <div class="field"><label for="capture-mode">Tipo</label><select id="capture-mode" name="capture_mode">${Object.entries(modeLabels).map(([v,label]) => `<option value="${v}" ${v===mode?'selected':''}>${label}</option>`).join('')}</select></div>
    <div class="field"><label for="capture-media">Mídia</label><select id="capture-media" name="media_type">${Object.entries(mediaLabels).map(([v,label]) => `<option value="${v}" ${v===media?'selected':''}>${label}</option>`).join('')}</select></div>
    <fieldset class="wide capture-channels"><legend>Canais</legend><button class="ghost" type="button" id="capture-all-channels">Selecionar todos</button><div class="channel-checks">${cameras.map(c => `<label><input type="checkbox" name="channels" value="${c.channel}" ${!draft.channels||draft.channels.map(Number).includes(c.channel)?'checked':''}> Canal ${c.channel} · ${html(c.name)}</label>`).join('') || '<span>Nenhuma câmera ativa neste DVR.</span>'}</div></fieldset>
    <div class="wide investigation-note">Apenas movimento usa a detecção do próprio DVR. IA seleciona eventos registrados pela IA do DVR. Foto solicita somente imagens; Todos solicita fotos e vídeos. Os intervalos configurados de cada canal serão preservados. A análise posterior é uma etapa separada.</div>
    <div class="wide capture-availability" role="status">A captura começa quando o receptor atualizado estiver conectado ao DVR. Movimento e IA usam as gravações marcadas pelo próprio DVR. Fotos são capturadas durante o playback. Recursos recusados pelo equipamento aparecem como falha, com o motivo.</div>
    <div class="wide"><button class="primary" type="submit" ${!cameras.length?'disabled':''}>Registrar captura</button></div>
  </form>`;
}
export function captureList(rows) {
  return `<div class="investigation-list">${rows.length ? rows.map(row => `<article class="summary-card">
    <div class="summary-head"><div><strong>${html(row.unit_name)} · ${html(row.dvr_name)}</strong><small>${displayDate(row.start_at)} até ${displayDate(row.end_at)} · São Paulo</small></div><span class="status-badge">${html(statusLabels[row.effective_status] || row.effective_status)}</span></div>
    <div class="summary-meta"><span>Tipo: ${modeLabels[row.capture_mode]}</span><span>Mídia: ${mediaLabels[row.media_type]}</span></div>
    <div class="channel-checks compact">${row.channels.map(ch => `<span>Canal ${ch.channel} · ${html(ch.camera_name)}${ch.status?' · '+html(statusLabels[ch.status]||ch.status):''}${ch.media_count!=null?' · '+ch.media_count+' mídias':''}${ch.events_found!=null?' · '+ch.events_found+' registros do DVR':''}${ch.cursor_at?' · processado até '+displayDate(ch.cursor_at):''}${ch.last_error?' · '+html(ch.last_error):''}${ch.retrieved_media_id?` <button class="ghost" data-investigation-video="${ch.retrieved_media_id}">Assistir</button>`:''}${(ch.media||[]).map(m=>` <button class="ghost" data-investigation-video="${m.media_id}">${m.content_type==='image/jpeg'?'Ver foto':'Assistir'} · ${displayDate(m.recorded_at)}</button>`).join('')}${ch.media_count>20?` <button class="ghost" data-capture-more="${row.id}" data-camera="${ch.camera_id}" data-offset="20">Mais mídias</button>`:''}</span>`).join('')}</div>
    ${row.effective_error?`<p class="investigation-note">${html(row.effective_error)}</p>`:''}
  </article>`).join('') : '<div class="empty">Nenhuma captura por período registrada.</div>'}</div>`;
}

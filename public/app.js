const $ = s => document.querySelector(s);
const state = { token: '', data: null, unitId: null, edit: null, objectUrls: [], view: 'config', summaries: null };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const toast = (message, error = false) => { const el = $('#toast'); el.textContent = message; el.className = `show${error ? ' error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = '', 4000); };
const accessLabel = mode => ({ sftp_push:'SFTP · DVR envia', ftp_push:'FTP · gateway', direct_http:'HTTP/RTSP direto', intelbras_cloud:'Intelbras Cloud · homologação', agent:'Agente legado', vpn:'VPN legada' }[mode] || mode);
const dateTime = value => value ? new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : 'nunca';
function ensureShell() {
  const intro = document.querySelector('.intro');
  if (intro && !document.querySelector('#refresh')) {
    const button = document.createElement('button'); button.id='refresh'; button.className='ghost'; button.textContent='Atualizar';
    intro.appendChild(button);
  }
  const stats = document.querySelector('#stats');
  if (stats && !document.querySelector('#ingest-status')) {
    const section=document.createElement('section'); section.id='ingest-status'; section.className='panel ingest-status'; stats.after(section);
  }
  const content=document.querySelector('.content');
  if (content && !document.querySelector('#recent-media')) {
    const section=document.createElement('section'); section.id='recent-media'; section.className='panel recent-media'; content.appendChild(section);
  }
}
ensureShell();
async function api(path, method = 'GET', data) {
  const response = await fetch(`/api/${path}`, { method, headers: { Authorization: `Bearer ${state.token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `Erro ${response.status}`);
  return result;
}
function setView(view) {
  state.view = view;
  const config = view === 'config';
  $('#stats').hidden = !config;
  $('#ingest-status').hidden = !config;
  document.querySelector('.layout').hidden = !config;
  $('#summaries-view').hidden = config;
  $('#add-unit').hidden = !config;
  $('#show-config').classList.toggle('active', config);
  $('#show-summaries').classList.toggle('active', !config);
}
async function loadSummaries() {
  state.summaries = await api('fraud/summaries?limit=100');
  renderSummaries();
}
function renderSummaries() {
  const rows = state.summaries?.incidents || [];
  const byUnit = new Map();
  for (const row of rows) {
    const key = row.unit_name || 'Unidade';
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(row);
  }
  $('#summaries-view').innerHTML = `<div class="section-head"><div><div class="eyebrow">RESUMOS</div><h2>Ocorrências para conferência humana</h2><p>Eventos classificados automaticamente como Grave - Fraude.</p></div><button class="ghost" id="refresh-summaries">Atualizar</button></div>${rows.length ? [...byUnit.entries()].map(([unit,items]) => `
    <section class="summary-unit"><h3>${escapeHtml(unit)}</h3>${items.map(item => `
      <article class="summary-card">
        <div class="summary-head"><div><strong>${new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(item.occurred_at))} · Grave - Fraude</strong><small>${dateTime(item.occurred_at)} · ${escapeHtml(item.camera_name || item.dvr_name || '')}</small></div><span class="fraud-badge">Grave - Fraude</span></div>
        <p class="summary-text">${escapeHtml(item.summary)}</p>
        <p><b>Motivo da preocupação:</b> ${escapeHtml(item.rationale)}</p>
        <div class="evidence-grid">${(item.evidence||[]).map(ev => `<figure><img data-summary-media="${ev.media_id}" alt="Evidência ${ev.evidence_order}"><figcaption>Quadro ${ev.evidence_order}${ev.frame_offset_seconds != null ? ' · +'+ev.frame_offset_seconds+'s' : ''}</figcaption></figure>`).join('')}</div>
        ${item.video_media_id ? `<div class="review-video"><video controls preload="metadata" data-summary-video="${item.video_media_id}"></video></div>` : ''}
        <div class="summary-meta"><span>Confiança IA: ${Math.round(Number(item.confidence||0)*100)}%</span><span>WhatsApp 9h: ${escapeHtml(item.alert_status)}</span></div>
      </article>`).join('')}</section>`).join('') : '<div class="empty"><strong>Nenhuma ocorrência Grave - Fraude.</strong>Os eventos classificados pela IA aparecerão aqui para revisão.</div>'}`;
  $('#refresh-summaries')?.addEventListener('click',()=>loadSummaries().then(()=>toast('Resumos atualizados.')).catch(e=>toast(e.message,true)));
  loadSummaryMedia();
}
async function loadSummaryMedia() {
  for (const el of document.querySelectorAll('[data-summary-media],[data-summary-video]')) {
    const id = el.dataset.summaryMedia || el.dataset.summaryVideo;
    try {
      const response = await fetch(`/api/media/${id}`, { headers: { Authorization: `Bearer ${state.token}` } });
      if (!response.ok) continue;
      const url = URL.createObjectURL(await response.blob()); state.objectUrls.push(url); el.src = url;
    } catch {}
  }
}

function normalizeIds() {
  for (const key of ['units','dvrs','cameras','recent_media']) (state.data[key] || []).forEach(row => {
    for (const idKey of ['id','unit_id','dvr_id','camera_id','event_id']) if (row[idKey] != null) row[idKey] = Number(row[idKey]);
  });
}
async function refresh() {
  state.data = await api('config');
  normalizeIds();
  if (!state.data.units.some(u => u.id === state.unitId)) state.unitId = state.data.units[0]?.id ?? null;
  render();
  if (state.view === 'summaries') await loadSummaries();
}
function render() {
  const { units, dvrs, cameras, recent_media: recent = [] } = state.data;
  $('#stats').innerHTML = [
    ['Unidades', units.filter(x => x.active).length, 'cadastradas e ativas'],
    ['DVRs', dvrs.filter(x => x.active).length, 'gravadores ativos'],
    ['Câmeras', cameras.filter(x => x.active).length, 'canais cadastrados'],
    ['Recebimentos 24h', state.data.received_24h || 0, 'arquivos capturados']
  ].map(([title, value, sub]) => `<div class="stat panel"><span>${title}</span><strong>${value}</strong><small>${sub}</small></div>`).join('');
  const ingest = state.data.ingest || {};
  $('#ingest-status').innerHTML = `<div><div class="eyebrow">RECEPTOR INTELBRAS</div><h2>SFTP ${ingest.host && ingest.port ? '<span class="badge">Disponível</span>' : '<span class="badge off">Aguardando rede</span>'}</h2><p>${ingest.host && ingest.port ? `${escapeHtml(ingest.host)}:${escapeHtml(ingest.port)} · usuário ${escapeHtml(ingest.username)}` : 'O serviço está preparado; o endereço público será preenchido após ativar o TCP Proxy na Railway.'}</p></div><div class="meta"><span>Scanner <b>${state.data.ingest_worker?.ok ? 'operacional' : 'atenção'}</b></span><span>Última varredura <b>${dateTime(state.data.ingest_worker?.last_scan_at)}</b></span></div>`;
  $('#unit-list').innerHTML = units.length ? units.map(u => `<button class="unit-item ${u.id === state.unitId ? 'selected' : ''}" data-unit="${u.id}"><span class="avatar">${escapeHtml(u.code.slice(0, 2))}</span><span><b>${escapeHtml(u.name)}</b><small>${escapeHtml(u.code)} · ${dvrs.filter(d => d.unit_id === u.id).length} DVR(s)</small></span></button>`).join('') : '<div class="empty">Nenhuma unidade cadastrada.</div>';
  const unit = units.find(u => u.id === state.unitId);
  if (!unit) {
    $('#overview').innerHTML = '<div class="empty"><strong>Comece por uma unidade</strong>Cadastre a primeira loja para adicionar DVRs e câmeras.</div>';
    $('#dvr-list').innerHTML = '';
    $('#recent-media').innerHTML = '';
    return;
  }
  const selected = dvrs.filter(d => d.unit_id === unit.id);
  $('#overview').innerHTML = `<div class="section-head"><div><div class="eyebrow">UNIDADE SELECIONADA</div><h2>${escapeHtml(unit.name)}</h2><p>${escapeHtml(unit.city || 'Localidade não informada')} · ${escapeHtml(unit.code)}</p></div><div class="tools"><button class="ghost" data-edit="unit:${unit.id}">Editar</button><button class="primary" data-add="dvr">+ Adicionar DVR</button></div></div><div class="meta"><span>Status <b>${unit.active ? 'Ativa' : 'Inativa'}</b></span><span>Gravadores <b>${selected.length}</b></span><span>Câmeras configuradas <b>${cameras.filter(c => selected.some(d => d.id === c.dvr_id)).length}</b></span></div>`;
  $('#dvr-list').innerHTML = selected.length ? selected.map(d => {
    const cams = cameras.filter(c => c.dvr_id === d.id);
    return `<article class="dvr panel"><div class="section-head"><div class="dvr-title"><span class="device-icon">▣</span><div><h3>${escapeHtml(d.name)} <span class="badge ${d.active ? '' : 'off'}">${d.active ? 'Ativo' : 'Inativo'}</span></h3><p>${escapeHtml(d.model)} · ${d.channel_count} canais · ${escapeHtml(accessLabel(d.access_mode))}${d.remote_connection_mode ? ' · acesso remoto ' + escapeHtml(d.remote_connection_mode === 'cloud' ? 'Cloud' : d.remote_connection_mode) : ''}${d.cloud_serial ? ' · Serial ' + escapeHtml(d.cloud_serial) : ''}</p></div></div><div class="tools"><button class="ghost" data-edit="dvr:${d.id}">Configurar</button><button class="ghost" data-add="camera:${d.id}">+ Câmera</button></div></div><div class="dvr-ingest"><span>Local SFTP <code>${escapeHtml(d.ingest_key || '—')}</code></span><span>Último arquivo <b>${dateTime(d.last_ingest_at)}</b></span></div><div class="camera-grid">${cams.map(c => `<div class="camera" role="button" tabindex="0" data-edit="camera:${c.id}"><span class="lens">◉</span><div><b>${escapeHtml(c.name)}</b><small>Canal ${c.channel} · ${escapeHtml(c.area || 'Área não definida')}</small><em class="${c.active && c.policy.enabled ? '' : 'muted'}">${c.active && c.policy.enabled ? `${c.policy.offsets.length} marco(s) · ${c.policy.analysis_mode === 'manual' ? 'IA manual' : c.policy.analysis_mode === 'off' ? 'sem IA' : 'IA agendada'}` : 'Captura desligada'}${c.device_config_status ? ` · DVR ${c.device_config_status === 'confirmed' ? 'confirmado' : c.device_config_status === 'pending' ? 'pendente' : c.device_config_status}` : ''}</em></div></div>`).join('')}</div>${cams.length ? '' : '<div class="empty">Nenhuma câmera cadastrada neste DVR.</div>'}</article>`;
  }).join('') : '<div class="panel empty"><strong>Sem DVR nesta unidade</strong>Adicione o gravador para configurar os canais.</div>';
  renderRecent(recent.filter(m => m.unit_id === unit.id));
  setView(state.view);
}
function renderRecent(items) {
  state.objectUrls.forEach(URL.revokeObjectURL); state.objectUrls = [];
  $('#recent-media').innerHTML = `<div class="section-head"><div><div class="eyebrow">ÚLTIMOS RECEBIMENTOS</div><h2>Imagens recebidas do DVR</h2></div></div>${items.length ? `<div class="media-grid">${items.map(m => `<article class="media-card"><div class="thumb">${m.content_type?.startsWith('image/') ? `<img data-media-thumb="${m.id}" alt="${escapeHtml(m.filename)}">` : '<span>ARQ</span>'}</div><div><b>${escapeHtml(m.camera_name || (m.detected_channel ? `Canal ${m.detected_channel}` : 'Canal a identificar'))}</b><small>${escapeHtml(m.dvr_name)} · ${dateTime(m.received_at)}</small><em>${Math.max(1,Math.round(Number(m.bytes)/1024))} KB</em></div></article>`).join('')}</div>` : '<div class="empty">Ainda não recebemos arquivos desta unidade.</div>'}`;
  loadThumbs();
}
async function loadThumbs() {
  for (const img of document.querySelectorAll('[data-media-thumb]')) {
    try {
      const response = await fetch(`/api/media/${img.dataset.mediaThumb}`, { headers: { Authorization: `Bearer ${state.token}` } });
      if (!response.ok) continue;
      const url = URL.createObjectURL(await response.blob()); state.objectUrls.push(url); img.src = url;
    } catch {}
  }
}
const field = (name, label, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
const select = (name, label, value, choices) => `<label>${label}<select name="${name}">${choices.map(([v, text]) => `<option value="${escapeHtml(v)}" ${String(value) === String(v) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
const checked = (name, text, value) => `<label class="check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}>${text}</label>`;
function edit(type, row = null, parentId = null) {
  state.edit = { type, row };
  const { units, dvrs, defaults, ingest } = state.data;
  const form = $('#fields');
  $('#dialog-kicker').textContent = type === 'unit' ? 'UNIDADE' : type === 'dvr' ? 'GRAVADOR' : 'CANAL';
  $('#dialog-title').textContent = `${row ? 'Editar' : 'Nova'} ${type === 'unit' ? 'unidade' : type === 'dvr' ? 'DVR' : 'câmera'}`;
  if (type === 'unit') form.innerHTML = `${field('name','Nome da unidade',row?.name,'text','required maxlength="120"')}${field('code','Sigla',row?.code,'text','required maxlength="24"')}${field('city','Cidade / localização',row?.city)}${checked('active','Unidade ativa',row?.active ?? true)}`;
  if (type === 'dvr') {
    const server = ingest?.host && ingest?.port ? `${ingest.host}:${ingest.port}` : 'será exibido após ativar o TCP Proxy';
    form.innerHTML = `${select('unit_id','Unidade',row?.unit_id ?? state.unitId,units.map(u => [u.id,u.name]))}${field('name','Identificação do DVR',row?.name,'text','required')}${select('model','Modelo',row?.model ?? 'MHDX 1104',['MHDX 1104','MHDX 1108','MHDX 3108','MHDX 3116','Outro'].map(x => [x,x]))}${field('cloud_serial','Número de série (Intelbras Cloud)',row?.cloud_serial,'text','placeholder="Serial exibido no aplicativo Intelbras" maxlength="80"')}${select('remote_connection_mode','Método de acesso remoto',row?.remote_connection_mode ?? 'cloud',[['cloud','Cloud'],['domain','Domínio'],['ip','Endereço IP'],['ip_extra','IP Extra']])}${field('access_username','Usuário do DVR / Cloud',row?.access_username,'text','placeholder="admin" maxlength="120"')}${select('access_mode','Integração principal',row?.access_mode ?? 'sftp_push',[['sftp_push','SFTP — DVR envia ao COP (recomendado)'],['ftp_push','FTP — DVR envia ao gateway'],['direct_http','HTTP/RTSP — acesso direto ao DVR'],['intelbras_cloud','Intelbras Cloud/P2P — em homologação']])}${row?.ingest_key ? field('ingest_key','Diretório Local no DVR',row.ingest_key,'text','readonly') : '<div class="note">O diretório de ingestão será gerado automaticamente ao salvar o DVR.</div>'}<div class="note"><b>Configuração SFTP no DVR:</b><br>Servidor: ${escapeHtml(server)}<br>Usuário: ${escapeHtml(ingest?.username || 'cop_ingest')}<br>Local: ${escapeHtml(row?.ingest_key || 'gerado após salvar')}<br>Em cada canal desejado, habilite <b>Foto + DM</b>. Começaremos somente com fotos.</div><div class="row">${field('channel_count','Quantidade de canais',row?.channel_count ?? 4,'number','min="1" max="32" required')}${field('service_port','Porta Intelbras',row?.service_port ?? 37777,'number','min="1" max="65535" required')}</div><div class="row">${field('http_port','Porta HTTP',row?.http_port ?? 80,'number','min="1" max="65535" required')}${field('rtsp_port','Porta RTSP',row?.rtsp_port ?? 554,'number','min="1" max="65535" required')}</div>${field('host','IP/DDNS do DVR (opcional)',row?.host,'text','placeholder="Somente para acesso direto/VPN"')}${field('connector_id','Identificador complementar (opcional)',row?.connector_id)}${field('secret_ref','Variável segura da senha do DVR',row?.secret_ref,'text','placeholder="COP_DVR_CEREJEIRAS_PASSWORD"')}${checked('active','DVR ativo',row?.active ?? true)}`;
  }
  if (type === 'camera') {
    const dvrId = row?.dvr_id ?? parentId;
    const p = row?.policy ?? defaults;
    form.innerHTML = `${select('dvr_id','DVR',dvrId,dvrs.map(d => [d.id,`${units.find(u => u.id === d.unit_id)?.name ?? ''} · ${d.name}`]))}<div class="row">${field('channel','Número do canal',row?.channel ?? 1,'number','min="1" max="32" required')}${field('name','Nome da câmera',row?.name,'text','required')}</div>${field('area','Área observada',row?.area,'text','placeholder="Entrada, caixa, corredor..."')}<div class="note">No modo SFTP, o DVR envia as fotos de DM. Os marcos abaixo orientam a seleção futura de frames para IA e podem chegar a 600 s.</div>${checked('enabled','Usar imagens deste canal no COP',p.enabled)}${field('offsets','Marcos de análise em segundos',p.offsets.join(', '),'text','required')}<div class="row">${field('cooldown_seconds','Pausa entre eventos (s)',p.cooldown_seconds,'number','min="0" max="3600" required')}${field('min_motion_seconds','Duração mínima (s)',p.min_motion_seconds,'number','min="0" max="600" required')}</div>${select('analysis_mode','Enviar para análise por IA',p.analysis_mode,[['off','Não enviar'],['manual','Somente sob comando'],['always','A cada evento válido'],['duration','Após duração mínima']])}<div class="row">${field('analysis_after_seconds','Duração para IA (s)',p.analysis_after_seconds,'number','min="0" max="3600" required')}${field('retention_days','Guardar mídia por (dias)',p.retention_days,'number','min="1" max="365" required')}</div>${checked('active','Câmera ativa',row?.active ?? true)}`;
  }
  $('#editor').showModal();
}
function value(form, key) { return form.elements.namedItem(key).value.trim(); }
const number = (form, key) => Number(value(form,key));
function payload(form, type) {
  const active = form.elements.namedItem('active').checked;
  if (type === 'unit') return { name:value(form,'name'), code:value(form,'code'), city:value(form,'city'), active };
  if (type === 'dvr') return { unit_id:value(form,'unit_id'), name:value(form,'name'), model:value(form,'model'), cloud_serial:value(form,'cloud_serial'), remote_connection_mode:value(form,'remote_connection_mode'), access_username:value(form,'access_username'), channel_count:number(form,'channel_count'), access_mode:value(form,'access_mode'), host:value(form,'host'), http_port:number(form,'http_port'), rtsp_port:number(form,'rtsp_port'), service_port:number(form,'service_port'), connector_id:value(form,'connector_id'), secret_ref:value(form,'secret_ref'), active };
  return { dvr_id:value(form,'dvr_id'), channel:number(form,'channel'), name:value(form,'name'), area:value(form,'area'), active,
    policy: { enabled:form.elements.namedItem('enabled').checked,
      offsets:value(form,'offsets').split(',').map(n => Number(n.trim())),
      cooldown_seconds:number(form,'cooldown_seconds'), min_motion_seconds:number(form,'min_motion_seconds'),
      analysis_mode:value(form,'analysis_mode'), analysis_after_seconds:number(form,'analysis_after_seconds'),
      retention_days:number(form,'retention_days') } };
}
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); state.token = $('#token').value; try { await refresh(); $('#login').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false; $('#token').value = ''; } catch (error) { state.token = ''; toast(error.message, true); } });
$('#logout').addEventListener('click', () => { state.objectUrls.forEach(URL.revokeObjectURL); state.objectUrls=[]; state.token = ''; state.data = null; $('#workspace').hidden = true; $('#login').hidden = false; $('#logout').hidden = true; });
$('#show-config').addEventListener('click', () => { setView('config'); });
$('#show-summaries').addEventListener('click', () => { setView('summaries'); loadSummaries().catch(error => toast(error.message,true)); });
$('#add-unit').addEventListener('click', () => edit('unit'));
$('#refresh').addEventListener('click', () => refresh().then(() => toast('Dados atualizados.')).catch(error => toast(error.message,true)));
$('#workspace').addEventListener('click', e => {
  const unit = e.target.closest('[data-unit]'); if (unit) { state.unitId = Number(unit.dataset.unit); render(); return; }
  const add = e.target.closest('[data-add]'); if (add) { const [type, id] = add.dataset.add.split(':'); edit(type, null, id ? Number(id) : null); return; }
  const target = e.target.closest('[data-edit]'); if (target) { const [type,id] = target.dataset.edit.split(':'); const source = { unit:'units', dvr:'dvrs', camera:'cameras' }[type]; edit(type, state.data[source].find(x => x.id === Number(id))); }
});
$('#workspace').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const target = e.target.closest('.camera'); if (target) { e.preventDefault(); target.click(); } } });
$('#close-editor').addEventListener('click', () => $('#editor').close());
$('#cancel-editor').addEventListener('click', () => $('#editor').close());
$('#edit-form').addEventListener('submit', async e => {
  e.preventDefault(); const {type,row} = state.edit; const name = {unit:'units',dvr:'dvrs',camera:'cameras'}[type];
  try { await api(row ? `${name}/${row.id}` : name, row ? 'PUT' : 'POST', payload(e.currentTarget,type)); $('#editor').close(); await refresh(); toast('Configuração salva.'); }
  catch(error) { toast(error.message,true); }
});

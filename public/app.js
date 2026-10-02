const $ = s => document.querySelector(s);
const state = { token: '', data: null, unitId: null, edit: null, objectUrls: [], view: 'config', summaries: null, investigations: null };
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
  const config = view === 'config', summaries = view === 'summaries', investigations = view === 'investigations';
  $('#stats').hidden = !config;
  $('#ingest-status').hidden = !config;
  document.querySelector('.layout').hidden = !config;
  $('#servers-view').hidden = view!=='servers';
  $('#show-servers').classList.toggle('active',view==='servers');
  $('#summaries-view').hidden = !summaries;
  $('#investigations-view').hidden = !investigations;
  $('#add-unit').hidden = !config;
  $('#show-config').classList.toggle('active', config);
  $('#show-summaries').classList.toggle('active', summaries);
  $('#show-investigations').classList.toggle('active', investigations);
}
async function loadInvestigations() {
  state.investigations = await api('investigations?limit=100');
  renderInvestigations();
}
function investigationForm() {
  const units=state.data?.units||[];
  const unit=units.find(u=>u.id===state.unitId)||units[0];
  const dvr=state.data?.dvrs?.find(d=>d.unit_id===unit?.id&&d.active);
  const cameras=(state.data?.cameras||[]).filter(c=>c.dvr_id===dvr?.id&&c.active);
  const local=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  return `<form id="investigation-form" class="investigation-form">
    <div class="field"><label>Unidade</label><select name="unit_id">${units.map(u=>`<option value="${u.id}" ${u.id===unit?.id?'selected':''}>${escapeHtml(u.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Data e horário de referência</label><input name="reference_at" type="datetime-local" value="${local}" required></div>
    <div class="field"><label>Minutos antes</label><input name="before" type="number" min="0" max="60" value="5"></div>
    <div class="field"><label>Minutos depois</label><input name="after" type="number" min="0" max="60" value="10"></div>
    <div class="field wide"><label>Motivo da investigação</label><textarea name="reason" maxlength="2000" placeholder="Ex.: pagamento não localizado; revisão operacional; divergência de estoque." required></textarea></div>
    <div class="field wide"><label>Canais</label><div id="investigation-channels" class="channel-checks">${cameras.map(cam=>`<label><input type="checkbox" name="channels" value="${cam.channel}" checked> Canal ${cam.channel} · ${escapeHtml(cam.name)}</label>`).join('')||'<span class="muted">Nenhuma câmera cadastrada.</span>'}</div></div>
    <div class="wide investigation-note">Os canais selecionados serão recuperados quando o DVR e seu conector estiverem disponíveis. Os vídeos aparecerão nesta investigação.</div>
    <div class="wide"><button class="primary" type="submit">Criar investigação</button></div>
  </form>`;
}
function renderInvestigations() {
  const rows=state.investigations?.investigations||[];
  $('#investigations-view').innerHTML=`<div class="section-head"><div><div class="eyebrow">INVESTIGAÇÕES</div><h2>Investigação retroativa</h2><p>Solicite uma janela histórica do DVR e múltiplos canais para reconstrução posterior.</p></div><button class="ghost" id="refresh-investigations">Atualizar</button></div>
  ${investigationForm()}
  <div class="investigation-list">${rows.length?rows.map(row=>`<article class="summary-card">
    <div class="summary-head"><div><strong>${escapeHtml(row.unit_name)} · ${dateTime(row.reference_at)}</strong><small>${escapeHtml(row.reason)}</small></div><span class="status-badge">${escapeHtml(row.status)}</span></div>
    <div class="summary-meta"><span>Janela: -${Math.round(row.window_before_seconds/60)} min / +${Math.round(row.window_after_seconds/60)} min</span><span>Fonte: ${escapeHtml(row.source)}</span><span>Conector: ${escapeHtml(row.connector_status)}</span></div>
    <div class="channel-checks compact">${(row.channels||[]).map(ch=>`<span>Canal ${ch.channel} · ${escapeHtml(ch.camera_name||'Câmera')} · ${escapeHtml(ch.status)}${ch.last_error?' · '+escapeHtml(ch.last_error):''}${ch.retrieved_media_id?` <button class="ghost" data-investigation-video="${ch.retrieved_media_id}">Assistir</button>`:''}</span>`).join('')}</div>
  </article>`).join(''):'<div class="empty"><strong>Nenhuma investigação criada.</strong>Use o formulário acima para registrar uma busca retroativa.</div>'}</div>`;
  for(const button of document.querySelectorAll('[data-investigation-video]'))button.addEventListener('click',async()=>{try{const response=await fetch(`/api/media/${button.dataset.investigationVideo}`,{headers:{Authorization:`Bearer ${state.token}`}});if(!response.ok)throw Error('Não foi possível carregar o vídeo.');const url=URL.createObjectURL(await response.blob());state.objectUrls.push(url);const video=document.createElement('video');video.controls=true;video.src=url;video.style.maxWidth='100%';button.replaceWith(video);}catch(e){toast(e.message,true);}});
  $('#refresh-investigations')?.addEventListener('click',()=>loadInvestigations().catch(e=>toast(e.message,true)));
  $('#investigation-form')?.addEventListener('submit',submitInvestigation);
  $('#investigation-form select[name="unit_id"]')?.addEventListener('change',()=>{state.unitId=Number($('#investigation-form select[name="unit_id"]').value);renderInvestigations();});
}
async function submitInvestigation(event) {
  event.preventDefault();
  const form=event.currentTarget,fd=new FormData(form);
  const channels=[...form.querySelectorAll('input[name="channels"]:checked')].map(el=>Number(el.value));
  if(!channels.length)return toast('Selecione pelo menos um canal.',true);
  const local=String(fd.get('reference_at')||'');
  const d=new Date(local);
  if(Number.isNaN(d.getTime()))return toast('Informe data e horário válidos.',true);
  try{
    await api('investigations','POST',{
      unit_id:Number(fd.get('unit_id')),reference_at:d.toISOString(),
      window_before_seconds:Number(fd.get('before'))*60,window_after_seconds:Number(fd.get('after'))*60,
      reason:String(fd.get('reason')||''),source:'manual',channels
    });
    toast('Investigação registrada.');
    await loadInvestigations();
  }catch(e){toast(e.message,true);}
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
  for (const key of ['units','dvrs','cameras','recent_media','servers','server_directories']) (state.data[key] || []).forEach(row => {
    for (const idKey of ['id','unit_id','dvr_id','camera_id','event_id','server_id','server_directory_id']) if (row[idKey] != null) row[idKey] = Number(row[idKey]);
  });
}
async function refresh() {
  state.data = await api('config');
  normalizeIds();
  if (!state.data.units.some(u => u.id === state.unitId)) state.unitId = state.data.units[0]?.id ?? null;
  render();
  renderServers();
  setView(state.view);
  if (state.view === 'summaries') await loadSummaries();
  if (state.view === 'investigations') await loadInvestigations();
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
  renderServers();
  setView(state.view);
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
    return `<article class="dvr panel"><div class="section-head"><div class="dvr-title"><span class="device-icon">▣</span><div><h3>${escapeHtml(d.name)} <span class="badge ${d.active ? '' : 'off'}">${d.active ? 'Ativo' : 'Inativo'}</span></h3><p>${escapeHtml(d.model)} · ${d.channel_count} canais · ${escapeHtml(accessLabel(d.access_mode))}${d.remote_connection_mode ? ' · acesso remoto ' + escapeHtml(d.remote_connection_mode === 'cloud' ? 'Cloud' : d.remote_connection_mode) : ''}${d.cloud_serial ? ' · Serial ' + escapeHtml(d.cloud_serial) : ''}</p></div></div><div class="tools"><button class="ghost" data-edit="dvr:${d.id}">Configurar</button><button class="ghost" data-add="camera:${d.id}">+ Câmera</button></div></div><div class="dvr-ingest"><span>Servidor <b>${escapeHtml((state.data.servers||[]).find(s=>s.id===d.server_id)?.name||'Não selecionado')}</b> · Diretório <b>${escapeHtml((state.data.server_directories||[]).find(s=>s.id===d.server_directory_id)?.friendly_name||'Não selecionado')}</b></span><span>Local SFTP <code>${escapeHtml(d.ingest_key || '—')}</code></span><span>Último arquivo <b>${dateTime(d.last_ingest_at)}</b></span>${d.playback_mode==='netsdk_autoregister'?`<span>Gravações: <b>${d.sdk_online&&d.sdk_last_seen_at&&Date.now()-new Date(d.sdk_last_seen_at).getTime()<90000?'DVR conectado':'aguardando conexão'}</b> · ID ${escapeHtml(d.autoregister_id)}</span>`:''}</div><div class="camera-grid">${cams.map(c => `<div class="camera" role="button" tabindex="0" data-edit="camera:${c.id}"><span class="lens">◉</span><div><b>${escapeHtml(c.name)}</b><small>Canal ${c.channel} · ${escapeHtml(c.area || 'Área não definida')}</small><em class="${c.active && c.policy.enabled ? '' : 'muted'}">${c.active && c.policy.enabled ? `${c.policy.offsets.length} marco(s) · ${c.policy.analysis_mode === 'manual' ? 'IA manual' : c.policy.analysis_mode === 'off' ? 'sem IA' : 'IA agendada'}` : 'Captura desligada'}${c.device_config_status ? ` · DVR ${c.device_config_status === 'confirmed' ? 'confirmado' : c.device_config_status === 'pending' ? 'pendente' : c.device_config_status}` : ''}</em></div></div>`).join('')}</div>${cams.length ? '' : '<div class="empty">Nenhuma câmera cadastrada neste DVR.</div>'}</article>`;
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
function renderServers(){
 const servers=state.data.servers||[],dirs=state.data.server_directories||[];
 $('#servers-view').innerHTML=`<div class="section-head"><div><div class="eyebrow">INFRAESTRUTURA</div><h2>Servidores e diretórios</h2><p>Cadastre os servidores que recebem os dispositivos e seus diretórios.</p></div><button class="primary" data-add="server">+ Novo servidor</button></div>${servers.map(s=>`<article class="dvr panel"><div class="section-head"><div><h3>${escapeHtml(s.name)} <span class="badge ${s.active?'':'off'}">${s.active?'Ativo':'Inativo'}</span></h3><p>${escapeHtml(s.host)} · SSH ${s.ssh_port} · Auto Registro ${s.registration_port}</p></div><div class="tools"><button class="ghost" data-edit="server:${s.id}">Configurar</button><button class="ghost" data-add="directory:${s.id}">+ Diretório</button></div></div><div class="meta"><span>Usuário <b>${escapeHtml(s.access_username||'—')}</b></span><span>Diretório base <b>${escapeHtml(s.storage_root)}</b></span><span>Dispositivos <b>${state.data.dvrs.filter(d=>d.server_id===s.id).length}</b></span></div><div class="directory-list">${dirs.filter(d=>d.server_id===s.id).map(d=>`<button class="ghost" data-edit="directory:${d.id}"><b>${escapeHtml(d.friendly_name)}</b> · ${escapeHtml(d.directory_name)}</button>`).join('')||'<p>Nenhum diretório cadastrado.</p>'}</div></article>`).join('')||'<div class="empty">Cadastre o primeiro servidor.</div>'}`;
}
function secretField(name,label,saved=false){return `<label>${label}<span class="secret-control">${name==='private_key'?`<textarea name="${name}" class="masked-secret" rows="4" autocomplete="off" maxlength="8192" placeholder="${saved?'Chave salva; deixe vazio para manter':'Cole a chave privada SSH'}"></textarea>`:`<input name="${name}" type="password" autocomplete="new-password" maxlength="8192" placeholder="${saved?'Credencial salva; deixe vazio para manter':'Informe a credencial'}">`}<button type="button" class="ghost" data-secret="${name}" aria-label="Exibir ${label}">Exibir</button>${saved?`<button type="button" class="ghost" data-copy-secret="${name}">Copiar</button>`:''}</span></label>`;}
async function revealSecret(button,copy=false){const currentEdit=state.edit;const name=button.dataset.secret||button.dataset.copySecret,input=$('#edit-form').elements.namedItem(name);if(!copy&&(input.type==='text'||input.tagName==='TEXTAREA'&&!input.classList.contains('masked-secret'))){if(input.tagName==='TEXTAREA')input.classList.add('masked-secret');else input.type='password';button.textContent='Exibir';return;}try{if(!input.value&&state.edit.row){const endpoint=state.edit.type==='server'?'servers':'dvrs';const secrets=await api(`${endpoint}/${state.edit.row.id}/credentials`);if(state.edit!==currentEdit||!button.isConnected)return;input.value=secrets[name]||'';}if(copy){await navigator.clipboard.writeText(input.value);toast('Credencial copiada.');}else{if(input.tagName==='TEXTAREA')input.classList.remove('masked-secret');else input.type='text';button.textContent='Ocultar';}}catch(e){toast(e.message,true);}}
function updateDirectories(selected=''){const form=$('#edit-form'),server=form.elements.namedItem('server_id');if(!server)return;const dir=form.elements.namedItem('server_directory_id');dir.innerHTML=`<option value="">Sem diretório selecionado</option>${(state.data.server_directories||[]).filter(d=>String(d.server_id)===server.value).map(d=>`<option value="${d.id}" ${String(selected)===String(d.id)?'selected':''}>${escapeHtml(d.friendly_name)} · ${escapeHtml(d.directory_name)}</option>`).join('')}`;const s=(state.data.servers||[]).find(s=>String(s.id)===server.value);if(s)form.elements.namedItem('sdk_connector_name').value=s.connector_name;}
const field = (name, label, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
const select = (name, label, value, choices) => `<label>${label}<select name="${name}">${choices.map(([v, text]) => `<option value="${escapeHtml(v)}" ${String(value) === String(v) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
const checked = (name, text, value) => `<label class="check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}>${text}</label>`;
function edit(type, row = null, parentId = null) {
  state.edit = { type, row };
  const { units, dvrs, defaults, ingest } = state.data;
  const form = $('#fields');
  $('#edit-form').dataset.recordId=row?.id||'';
  $('#dialog-kicker').textContent = type === 'unit' ? 'UNIDADE' : type === 'dvr' ? 'GRAVADOR' : 'CANAL';
  $('#dialog-title').textContent = `${row ? 'Editar' : 'Nova'} ${type === 'unit' ? 'unidade' : type === 'dvr' ? 'DVR' : 'câmera'}`;
  if(type==='server'){
  $('#dialog-kicker').textContent='SERVIDOR';$('#dialog-title').textContent=row?'Editar servidor':'Novo servidor';
  form.innerHTML=`${field('name','Nome amigável',row?.name,'text','required maxlength="120"')}${field('host','IP ou domínio',row?.host,'text','required maxlength="253"')}${field('connector_name','Identificador do receptor',row?.connector_name??'hostinger','text','required maxlength="64"')}<div class="row">${field('ssh_port','Porta SSH',row?.ssh_port??22,'number','min="1" max="65535" required')}${field('registration_port','Porta de Auto Registro',row?.registration_port??8000,'number','min="1" max="65535" required')}</div>${field('access_username','Usuário de acesso ao servidor',row?.access_username??'root')}${secretField('access_password','Senha do servidor',row?.password_saved)}${checked('clear_password','Remover senha salva',false)}${secretField('private_key','Chave privada SSH (opcional)',row?.private_key_saved)}${checked('clear_private_key','Remover chave privada salva',false)}${secretField('token','Token do conector',row?.token_saved)}<div class="note">Deixe o token vazio para gerar automaticamente no novo servidor ou manter o token atual. Depois de salvar, use Exibir ou Copiar.</div>${field('storage_root','Diretório base no servidor',row?.storage_root??'/var/lib/cop-pilot/sdk-jobs','text','required maxlength="240"')}${checked('active','Servidor ativo',row?.active??true)}`;
  }
  if(type==='directory'){
  $('#dialog-kicker').textContent='DIRETÓRIO';$('#dialog-title').textContent=row?'Editar diretório':'Novo diretório';
  const servers=state.data.servers||[];form.innerHTML=`${select('server_id','Servidor',row?.server_id??parentId,servers.map(s=>[s.id,s.name]))}${field('directory_name','Nome do diretório',row?.directory_name,'text','required placeholder="unidades/cerejeiras" maxlength="240"')}${field('friendly_name','Nome amigável',row?.friendly_name,'text','required maxlength="120"')}<div class="note">Informe o caminho relativo ao diretório base do servidor. A criação física ocorre quando o receptor processar a primeira tarefa.</div>`;if(row)form.querySelector('select').disabled=true;
  }
  if (type === 'unit') form.innerHTML = `${field('name','Nome da unidade',row?.name,'text','required maxlength="120"')}${field('code','Sigla',row?.code,'text','required maxlength="24"')}${field('city','Cidade / localização',row?.city)}${checked('active','Unidade ativa',row?.active ?? true)}`;
  if (type === 'dvr') {
    const server = ingest?.host && ingest?.port ? `${ingest.host}:${ingest.port}` : 'será exibido após ativar o TCP Proxy';
    form.innerHTML = `${select('unit_id','Unidade',row?.unit_id ?? state.unitId,units.map(u => [u.id,u.name]))}${field('name','Identificação do DVR',row?.name,'text','required')}${select('model','Modelo',row?.model ?? 'MHDX 1104',['MHDX 1104','MHDX 1108','MHDX 3108','MHDX 3116','Outro'].map(x => [x,x]))}${field('cloud_serial','Número de série (Intelbras Cloud)',row?.cloud_serial,'text','placeholder="Serial exibido no aplicativo Intelbras" maxlength="80"')}${select('remote_connection_mode','Método de acesso remoto',row?.remote_connection_mode ?? 'cloud',[['cloud','Cloud'],['domain','Domínio'],['ip','Endereço IP'],['ip_extra','IP Extra']])}${field('access_username','Usuário do DVR / Cloud',row?.access_username,'text','placeholder="admin" maxlength="120"')}${select('access_mode','Integração principal',row?.access_mode ?? 'sftp_push',[['sftp_push','SFTP — DVR envia ao COP (recomendado)'],['ftp_push','FTP — DVR envia ao gateway'],['direct_http','HTTP/RTSP — acesso direto ao DVR'],['intelbras_cloud','Intelbras Cloud/P2P — em homologação']])}${row?.ingest_key ? field('ingest_key','Diretório Local no DVR',row.ingest_key,'text','readonly') : '<div class="note">O diretório de ingestão será gerado automaticamente ao salvar o DVR.</div>'}<div class="note"><b>Configuração SFTP no DVR:</b><br>Servidor: ${escapeHtml(server)}<br>Usuário: ${escapeHtml(ingest?.username || 'cop_ingest')}<br>Local: ${escapeHtml(row?.ingest_key || 'gerado após salvar')}<br>Em cada canal desejado, habilite <b>Foto + DM</b>. Começaremos somente com fotos.</div><div class="row">${field('channel_count','Quantidade de canais',row?.channel_count ?? 4,'number','min="1" max="32" required')}${field('service_port','Porta Intelbras',row?.service_port ?? 37777,'number','min="1" max="65535" required')}</div><div class="row">${field('http_port','Porta HTTP',row?.http_port ?? 80,'number','min="1" max="65535" required')}${field('rtsp_port','Porta RTSP',row?.rtsp_port ?? 554,'number','min="1" max="65535" required')}</div>${field('host','IP/DDNS do DVR (opcional)',row?.host,'text','placeholder="Somente para acesso direto/VPN"')}${field('connector_id','Identificador complementar (opcional)',row?.connector_id)}${field('secret_ref','Variável segura da senha do DVR',row?.secret_ref,'text','placeholder="COP_DVR_CEREJEIRAS_PASSWORD"')}${checked('active','DVR ativo',row?.active ?? true)}`;
    form.innerHTML += `${select('server_id','Servidor utilizado',row?.server_id??'',[['','Sem servidor selecionado'],...(state.data.servers||[]).map(s=>[s.id,s.name+(s.active?'':' · Inativo')])])}${select('server_directory_id','Diretório da unidade',row?.server_directory_id??'',[['','Sem diretório selecionado']])}${secretField('access_password','Senha do dispositivo',row?.password_saved)}${checked('clear_password','Remover senha salva do dispositivo',false)}${select('playback_mode','Recuperação de gravações',row?.playback_mode ?? 'unavailable',[['unavailable','Não configurada'],['netsdk_autoregister','SDK · Auto Registro'],['rtsp_direct','RTSP direto'],['agent','Agente'],['cloud','Cloud · aguardando conector']])}${field('autoregister_id','ID de Auto Registro no DVR',row?.autoregister_id,'text','placeholder="101 para Cerejeiras" maxlength="128"')}${field('sdk_connector_name','Receptor de gravações',row?.sdk_connector_name ?? 'hostinger','text','maxlength="64"')}<div class="note">Para Auto Registro, o ID deve ser igual ao configurado no gravador e no receptor. A senha pode ser cadastrada acima e sincronizada pelo receptor vinculado ao servidor.</div>`;
  }
  if (type === 'camera') {
    const dvrId = row?.dvr_id ?? parentId;
    const p = row?.policy ?? defaults;
    form.innerHTML = `${select('dvr_id','DVR',dvrId,dvrs.map(d => [d.id,`${units.find(u => u.id === d.unit_id)?.name ?? ''} · ${d.name}`]))}<div class="row">${field('channel','Número do canal',row?.channel ?? 1,'number','min="1" max="32" required')}${field('name','Nome da câmera',row?.name,'text','required')}</div>${field('area','Área observada',row?.area,'text','placeholder="Entrada, caixa, corredor..."')}<div class="note">No modo SFTP, o DVR envia as fotos de DM. Os marcos abaixo orientam a seleção futura de frames para IA e podem chegar a 600 s.</div>${checked('enabled','Usar imagens deste canal no COP',p.enabled)}${field('offsets','Marcos de análise em segundos',p.offsets.join(', '),'text','required')}<div class="row">${field('cooldown_seconds','Pausa entre eventos (s)',p.cooldown_seconds,'number','min="0" max="3600" required')}${field('min_motion_seconds','Duração mínima (s)',p.min_motion_seconds,'number','min="0" max="600" required')}</div>${select('analysis_mode','Enviar para análise por IA',p.analysis_mode,[['off','Não enviar'],['manual','Somente sob comando'],['always','A cada evento válido'],['duration','Após duração mínima']])}<div class="row">${field('analysis_after_seconds','Duração para IA (s)',p.analysis_after_seconds,'number','min="0" max="3600" required')}${field('retention_days','Guardar mídia por (dias)',p.retention_days,'number','min="1" max="365" required')}</div>${checked('active','Câmera ativa',row?.active ?? true)}`;
  }
  if(type==='dvr'){updateDirectories(row?.server_directory_id);form.querySelector('[name=server_id]').addEventListener('change',()=>updateDirectories());}
  $('#editor').showModal();
}
function value(form, key) { return form.elements.namedItem(key).value.trim(); }
const number = (form, key) => Number(value(form,key));
function payload(form, type) {
  if(type==='directory')return {server_id:value(form,'server_id'),directory_name:value(form,'directory_name'),friendly_name:value(form,'friendly_name')};
  const active = form.elements.namedItem('active').checked;
  if(type==='server')return {name:value(form,'name'),host:value(form,'host'),connector_name:value(form,'connector_name'),ssh_port:number(form,'ssh_port'),registration_port:number(form,'registration_port'),access_username:value(form,'access_username'),storage_root:value(form,'storage_root'),token:form.elements.namedItem('token').value,access_password:form.elements.namedItem('access_password').value,private_key:form.elements.namedItem('private_key').value,clear_password:form.elements.namedItem('clear_password').checked,clear_private_key:form.elements.namedItem('clear_private_key').checked,active};
  if (type === 'unit') return { name:value(form,'name'), code:value(form,'code'), city:value(form,'city'), active };
  if (type === 'dvr') return { server_id:value(form,'server_id')||null,server_directory_id:value(form,'server_directory_id')||null,access_password:form.elements.namedItem('access_password').value,clear_password:form.elements.namedItem('clear_password').checked,playback_mode:value(form,'playback_mode'),autoregister_id:value(form,'autoregister_id'),sdk_connector_name:value(form,'sdk_connector_name'),unit_id:value(form,'unit_id'), name:value(form,'name'), model:value(form,'model'), cloud_serial:value(form,'cloud_serial'), remote_connection_mode:value(form,'remote_connection_mode'), access_username:value(form,'access_username'), channel_count:number(form,'channel_count'), access_mode:value(form,'access_mode'), host:value(form,'host'), http_port:number(form,'http_port'), rtsp_port:number(form,'rtsp_port'), service_port:number(form,'service_port'), connector_id:value(form,'connector_id'), secret_ref:value(form,'secret_ref'), active };
  return { dvr_id:value(form,'dvr_id'), channel:number(form,'channel'), name:value(form,'name'), area:value(form,'area'), active,
    policy: { enabled:form.elements.namedItem('enabled').checked,
      offsets:value(form,'offsets').split(',').map(n => Number(n.trim())),
      cooldown_seconds:number(form,'cooldown_seconds'), min_motion_seconds:number(form,'min_motion_seconds'),
      analysis_mode:value(form,'analysis_mode'), analysis_after_seconds:number(form,'analysis_after_seconds'),
      retention_days:number(form,'retention_days') } };
}
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); state.token = $('#token').value; try { await refresh(); $('#login').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false; $('#token').value = ''; } catch (error) { state.token = ''; toast(error.message, true); } });
$('#logout').addEventListener('click', () => { state.objectUrls.forEach(URL.revokeObjectURL); state.objectUrls=[]; state.token = ''; state.data = null; $('#workspace').hidden = true; $('#login').hidden = false; $('#logout').hidden = true; });
$('#show-servers').addEventListener('click',()=>{setView('servers');renderServers();});
$('#show-config').addEventListener('click', () => { setView('config'); });
$('#show-summaries').addEventListener('click', () => { setView('summaries'); loadSummaries().catch(error => toast(error.message,true)); });
$('#show-investigations').addEventListener('click', () => { setView('investigations'); loadInvestigations().catch(error => toast(error.message,true)); });
$('#add-unit').addEventListener('click', () => edit('unit'));
$('#refresh').addEventListener('click', () => refresh().then(() => toast('Dados atualizados.')).catch(error => toast(error.message,true)));
$('#workspace').addEventListener('click', e => {
  const unit = e.target.closest('[data-unit]'); if (unit) { state.unitId = Number(unit.dataset.unit); render(); return; }
  const add = e.target.closest('[data-add]'); if (add) { const [type, id] = add.dataset.add.split(':'); edit(type, null, id ? Number(id) : null); return; }
  const target = e.target.closest('[data-edit]'); if (target) { const [type,id] = target.dataset.edit.split(':'); const source = { unit:'units', dvr:'dvrs', camera:'cameras', server:'servers',directory:'server_directories' }[type]; edit(type, state.data[source].find(x => x.id === Number(id))); }
});
$('#workspace').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const target = e.target.closest('.camera'); if (target) { e.preventDefault(); target.click(); } } });
$('#fields').addEventListener('click',e=>{const b=e.target.closest('[data-secret],[data-copy-secret]');if(b)revealSecret(b,!!b.dataset.copySecret);});
$('#editor').addEventListener('close',()=>{$('#fields').innerHTML='';state.edit=null;});
$('#close-editor').addEventListener('click', () => $('#editor').close());
$('#cancel-editor').addEventListener('click', () => $('#editor').close());
$('#edit-form').addEventListener('submit', async e => {
  e.preventDefault(); const {type,row} = state.edit; const name = {unit:'units',dvr:'dvrs',camera:'cameras',server:'servers',directory:'server-directories'}[type];
  try { const saved=await api(row ? `${name}/${row.id}` : name, row ? 'PUT' : 'POST', payload(e.currentTarget,type)); $('#editor').close(); await refresh(); toast('Configuração salva.'); }
  catch(error) { toast(error.message,true); }
});


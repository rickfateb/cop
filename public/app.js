const $ = s => document.querySelector(s);
const state = { token: '', data: null, unitId: null, edit: null };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const toast = (message, error = false) => { const el = $('#toast'); el.textContent = message; el.className = `show${error ? ' error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = '', 4000); };
async function api(path, method = 'GET', data) {
  const response = await fetch(`/api/${path}`, { method, headers: { Authorization: `Bearer ${state.token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `Erro ${response.status}`);
  return result;
}
async function refresh() {
  state.data = await api('config');
  for (const key of ['units', 'dvrs', 'cameras']) state.data[key].forEach(row => {
    row.id = Number(row.id);
    if (row.unit_id) row.unit_id = Number(row.unit_id);
    if (row.dvr_id) row.dvr_id = Number(row.dvr_id);
  });
  if (!state.data.units.some(u => u.id === state.unitId)) state.unitId = state.data.units[0]?.id ?? null;
  render();
}
function render() {
  const { units, dvrs, cameras } = state.data;
  $('#stats').innerHTML = [
    ['Unidades', units.filter(x => x.active).length, 'cadastradas e ativas'],
    ['DVRs', dvrs.filter(x => x.active).length, 'gravadores ativos'],
    ['Câmeras', cameras.filter(x => x.active).length, 'canais cadastrados'],
    ['Captura ativa', cameras.filter(x => x.active && x.policy.enabled).length, 'câmeras selecionadas']
  ].map(([title, value, sub]) => `<div class="stat panel"><span>${title}</span><strong>${value}</strong><small>${sub}</small></div>`).join('');
  $('#unit-list').innerHTML = units.length ? units.map(u => `<button class="unit-item ${u.id === state.unitId ? 'selected' : ''}" data-unit="${u.id}"><span class="avatar">${escapeHtml(u.code.slice(0, 2))}</span><span><b>${escapeHtml(u.name)}</b><small>${escapeHtml(u.code)} · ${dvrs.filter(d => d.unit_id === u.id).length} DVR(s)</small></span></button>`).join('') : '<div class="empty">Nenhuma unidade cadastrada.</div>';
  const unit = units.find(u => u.id === state.unitId);
  if (!unit) {
    $('#overview').innerHTML = '<div class="empty"><strong>Comece por uma unidade</strong>Cadastre a primeira loja para adicionar DVRs e câmeras.</div>';
    $('#dvr-list').innerHTML = '';
    return;
  }
  const selected = dvrs.filter(d => d.unit_id === unit.id);
  $('#overview').innerHTML = `<div class="section-head"><div><div class="eyebrow">UNIDADE SELECIONADA</div><h2>${escapeHtml(unit.name)}</h2><p>${escapeHtml(unit.city || 'Localidade não informada')} · ${escapeHtml(unit.code)}</p></div><div class="tools"><button class="ghost" data-edit="unit:${unit.id}">Editar</button><button class="primary" data-add="dvr">+ Adicionar DVR</button></div></div><div class="meta"><span>Status <b>${unit.active ? 'Ativa' : 'Inativa'}</b></span><span>Gravadores <b>${selected.length}</b></span><span>Câmeras configuradas <b>${cameras.filter(c => selected.some(d => d.id === c.dvr_id)).length}</b></span></div>`;
  $('#dvr-list').innerHTML = selected.length ? selected.map(d => {
    const cams = cameras.filter(c => c.dvr_id === d.id);
    return `<article class="dvr panel"><div class="section-head"><div class="dvr-title"><span class="device-icon">▣</span><div><h3>${escapeHtml(d.name)} <span class="badge ${d.active ? '' : 'off'}">${d.active ? 'Ativo' : 'Inativo'}</span></h3><p>${escapeHtml(d.model)} · ${d.channel_count} canais · ${d.access_mode === 'agent' ? 'Agente local' : 'VPN'}</p></div></div><div class="tools"><button class="ghost" data-edit="dvr:${d.id}">Configurar</button><button class="ghost" data-add="camera:${d.id}">+ Câmera</button></div></div><div class="camera-grid">${cams.map(c => `<div class="camera" role="button" tabindex="0" data-edit="camera:${c.id}"><span class="lens">◉</span><div><b>${escapeHtml(c.name)}</b><small>Canal ${c.channel} · ${escapeHtml(c.area || 'Área não definida')}</small><em class="${c.active && c.policy.enabled ? '' : 'muted'}">${c.active && c.policy.enabled ? `${c.policy.offsets.length} foto(s) · ${c.policy.analysis_mode === 'manual' ? 'IA manual' : c.policy.analysis_mode === 'off' ? 'sem IA' : 'IA agendada'}` : 'Captura desligada'}</em></div></div>`).join('')}</div>${cams.length ? '' : '<div class="empty">Nenhuma câmera cadastrada neste DVR.</div>'}</article>`;
  }).join('') : '<div class="panel empty"><strong>Sem DVR nesta unidade</strong>Adicione o gravador para configurar os canais.</div>';
}
const field = (name, label, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}></label>`;
const select = (name, label, value, choices) => `<label>${label}<select name="${name}">${choices.map(([v, text]) => `<option value="${escapeHtml(v)}" ${String(value) === String(v) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
const checked = (name, text, value) => `<label class="check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}>${text}</label>`;
function edit(type, row = null, parentId = null) {
  state.edit = { type, row };
  const { units, dvrs, defaults } = state.data;
  const form = $('#fields');
  $('#dialog-kicker').textContent = type === 'unit' ? 'UNIDADE' : type === 'dvr' ? 'GRAVADOR' : 'CANAL';
  $('#dialog-title').textContent = `${row ? 'Editar' : 'Nova'} ${type === 'unit' ? 'unidade' : type === 'dvr' ? 'DVR' : 'câmera'}`;
  if (type === 'unit') form.innerHTML = `${field('name','Nome da unidade',row?.name,'text','required maxlength="120"')}${field('code','Sigla',row?.code,'text','required maxlength="24"')}${field('city','Cidade / localização',row?.city)}${checked('active','Unidade ativa',row?.active ?? true)}`;
  if (type === 'dvr') form.innerHTML = `${select('unit_id','Unidade',row?.unit_id ?? state.unitId,units.map(u => [u.id,u.name]))}${field('name','Identificação do DVR',row?.name,'text','required')}${select('model','Modelo',row?.model ?? 'MHDX 1104',['MHDX 1104','MHDX 1108','MHDX 3108','MHDX 3116','Outro'].map(x => [x,x]))}<div class="row">${field('channel_count','Quantidade de canais',row?.channel_count ?? 4,'number','min="1" max="32" required')}${select('access_mode','Conexão',row?.access_mode ?? 'agent',[['agent','Agente na loja'],['vpn','Rede privada / VPN']])}</div><div class="row">${field('host','Endereço local do DVR',row?.host,'text','placeholder="192.168.1.100"')}${field('http_port','Porta HTTP',row?.http_port ?? 80,'number','min="1" max="65535" required')}</div>${field('connector_id','Identificador do agente / VPN',row?.connector_id)}${field('secret_ref','Nome da variável com a senha',row?.secret_ref,'text','placeholder="COP_DVR_PEKIN_1"')}<div class="note">A senha do DVR não é salva aqui. Crie a variável de ambiente no serviço que fará a conexão. Prefira agente local ou VPN, sem expor a porta do DVR na internet.</div>${checked('active','DVR ativo',row?.active ?? true)}`;
  if (type === 'camera') {
    const dvrId = row?.dvr_id ?? parentId;
    const p = row?.policy ?? defaults;
    form.innerHTML = `${select('dvr_id','DVR',dvrId,dvrs.map(d => [d.id,`${units.find(u => u.id === d.unit_id)?.name ?? ''} · ${d.name}`]))}<div class="row">${field('channel','Número do canal',row?.channel ?? 1,'number','min="1" max="32" required')}${field('name','Nome da câmera',row?.name,'text','required')}</div>${field('area','Área observada',row?.area,'text','placeholder="Entrada, caixa, corredor..."')}<div class="note">As fotos são programadas a partir do início do movimento detectado pelo DVR. Exemplo: 0, 2, 5, 10 gera quatro capturas.</div>${checked('enabled','Capturar imagens quando houver movimento',p.enabled)}${field('offsets','Segundos das capturas (separados por vírgula)',p.offsets.join(', '),'text','required')}<div class="row">${field('cooldown_seconds','Pausa entre eventos (s)',p.cooldown_seconds,'number','min="0" max="3600" required')}${field('min_motion_seconds','Duração mínima do movimento (s)',p.min_motion_seconds,'number','min="0" max="300" required')}</div>${select('analysis_mode','Enviar para análise por IA',p.analysis_mode,[['off','Não enviar'],['manual','Somente sob comando'],['always','A cada evento válido'],['duration','Após duração mínima']])}<div class="row">${field('analysis_after_seconds','Duração para IA (s)',p.analysis_after_seconds,'number','min="0" max="3600" required')}${field('retention_days','Guardar fotos por (dias)',p.retention_days,'number','min="1" max="365" required')}</div>${checked('active','Câmera ativa',row?.active ?? true)}`;
  }
  $('#editor').showModal();
}
function value(form, key) { return form.elements.namedItem(key).value.trim(); }
const number = (form, key) => Number(value(form,key));
function payload(form, type) {
  const active = form.elements.namedItem('active').checked;
  if (type === 'unit') return { name:value(form,'name'), code:value(form,'code'), city:value(form,'city'), active };
  if (type === 'dvr') return { unit_id:value(form,'unit_id'), name:value(form,'name'), model:value(form,'model'), channel_count:number(form,'channel_count'), access_mode:value(form,'access_mode'), host:value(form,'host'), http_port:number(form,'http_port'), connector_id:value(form,'connector_id'), secret_ref:value(form,'secret_ref'), active };
  return { dvr_id:value(form,'dvr_id'), channel:number(form,'channel'), name:value(form,'name'), area:value(form,'area'), active,
    policy: { enabled:form.elements.namedItem('enabled').checked,
      offsets:value(form,'offsets').split(',').map(n => Number(n.trim())),
      cooldown_seconds:number(form,'cooldown_seconds'), min_motion_seconds:number(form,'min_motion_seconds'),
      analysis_mode:value(form,'analysis_mode'), analysis_after_seconds:number(form,'analysis_after_seconds'),
      retention_days:number(form,'retention_days') } };
}
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); state.token = $('#token').value; try { await refresh(); $('#login').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false; $('#token').value = ''; } catch (error) { state.token = ''; toast(error.message, true); } });
$('#logout').addEventListener('click', () => { state.token = ''; state.data = null; $('#workspace').hidden = true; $('#login').hidden = false; $('#logout').hidden = true; });
$('#add-unit').addEventListener('click', () => edit('unit'));
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

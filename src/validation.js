export const models = ['MHDX 1104', 'MHDX 1108', 'MHDX 3108', 'MHDX 3116', 'Outro'];
export const accessModes = ['sftp_push', 'ftp_push', 'direct_http', 'intelbras_cloud', 'agent', 'vpn'];
export const defaults = Object.freeze({
  enabled: false,
  offsets: [0, 5, 15, 30],
  cooldown_seconds: 60,
  min_motion_seconds: 0,
  analysis_mode: 'manual',
  analysis_after_seconds: 20,
  retention_days: 15
});
export function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Política inválida.');
  const p = { ...defaults, ...value };
  if (typeof p.enabled !== 'boolean') throw Error('Ativação inválida.');
  if (!Array.isArray(p.offsets) || p.offsets.length < 1 || p.offsets.length > 10 ||
      p.offsets.some(n => !Number.isInteger(n) || n < 0 || n > 600) ||
      new Set(p.offsets).size !== p.offsets.length || p.offsets[0] !== 0 ||
      p.offsets.some((n, i) => i && n < p.offsets[i - 1])) throw Error('Informe até 10 intervalos crescentes, começando em 0, até 600 segundos.');
  for (const [key, max] of [['cooldown_seconds', 3600], ['min_motion_seconds', 600], ['analysis_after_seconds', 3600], ['retention_days', 365]]) {
    if (!Number.isInteger(p[key]) || p[key] < (key === 'retention_days' ? 1 : 0) || p[key] > max) throw Error(`Valor inválido: ${key}.`);
  }
  if (!['manual', 'always', 'duration', 'off'].includes(p.analysis_mode)) throw Error('Modo de análise inválido.');
  p.retention_days = 15;
  return Object.fromEntries(Object.keys(defaults).map(key => [key, p[key]]));
}
export function nonEmpty(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw Error(`${label}: informe de 1 a ${max} caracteres.`);
  return value.trim();
}
export function optional(value, max = 255) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw Error('Texto muito longo.');
  return value.trim();
}
export function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${label}: use um número entre ${min} e ${max}.`);
  return value;
}


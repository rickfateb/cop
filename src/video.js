import { spawn } from 'node:child_process';
import path from 'node:path';

const supported = new Set(['.dav', '.mp4', '.mov', '.avi', '.h264', '.264']);

export function isExtractableVideo(filename) {
  return supported.has(path.extname(String(filename || '')).toLowerCase());
}

function frameAt(file, offsetSeconds, { timeoutMs = 25000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(offsetSeconds),
      '-i', file,
      '-frames:v', '1',
      '-q:v', '4',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let total = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Error(`Timeout extraindo frame em ${offsetSeconds}s`));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        child.kill('SIGKILL');
        return finish(Error(`Frame em ${offsetSeconds}s excedeu limite de ${maxBytes} bytes`));
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (Buffer.concat(errors).length < 65536) errors.push(chunk);
    });
    child.on('error', finish);
    child.on('close', code => {
      if (done) return;
      const data = Buffer.concat(chunks);
      if (code === 0 && data.length) return finish(null, data);
      const detail = Buffer.concat(errors).toString('utf8').trim().slice(-600);
      finish(Error(`FFmpeg não extraiu frame em ${offsetSeconds}s${detail ? ': ' + detail : ''}`));
    });
  });
}

export async function extractAiFrames(file, offsets, { logger = console } = {}) {
  const unique = [...new Set((offsets || []).filter(value => Number.isInteger(value) && value >= 0 && value <= 600))].sort((a, b) => a - b);
  const frames = [];
  for (const offset of unique) {
    try {
      const data = await frameAt(file, offset);
      frames.push({ offset, data });
    } catch (error) {
      logger.warn?.(`COP frame ignorado: ${path.basename(file)} @${offset}s: ${error.message}`);
    }
  }
  return frames;
}

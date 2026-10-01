import { spawn } from 'node:child_process';
import path from 'node:path';

const supported = new Set(['.dav', '.mp4', '.mov', '.avi', '.h264', '.264']);
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export function isExtractableVideo(filename) {
  return supported.has(path.extname(String(filename || '')).toLowerCase());
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function samplingConfig(deviceConfig = {}) {
  return {
    intervalSeconds: clampInt(deviceConfig.frame_interval_seconds, 3, 1, 30),
    maxFrames: clampInt(deviceConfig.max_ai_frames_per_video, 600, 10, 1200),
    width: clampInt(deviceConfig.ai_frame_width, 640, 320, 1280)
  };
}

export function extractAiFrames(file, { intervalSeconds = 3, maxFrames = 600, width = 640, timeoutMs = 120000, logger = console } = {}) {
  intervalSeconds = clampInt(intervalSeconds, 3, 1, 30);
  maxFrames = clampInt(maxFrames, 600, 10, 1200);
  width = clampInt(width, 640, 320, 1280);

  return new Promise((resolve, reject) => {
    const vf = `fps=1/${intervalSeconds},scale='min(${width},iw)':-2`;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-an', '-sn', '-dn',
      '-vf', vf,
      '-q:v', '7',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const frames = [];
    const errors = [];
    let pending = Buffer.alloc(0);
    let capped = false;
    let done = false;

    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        if (capped) logger.warn?.(`COP vídeo atingiu limite de ${maxFrames} frames: ${path.basename(file)}`);
        resolve(frames);
      }
    };

    const consume = () => {
      for (;;) {
        let start = pending.indexOf(SOI);
        if (start < 0) {
          pending = pending.length && pending[pending.length - 1] === 0xff ? pending.subarray(pending.length - 1) : Buffer.alloc(0);
          return;
        }
        if (start > 0) pending = pending.subarray(start);
        const end = pending.indexOf(EOI, 2);
        if (end < 0) return;
        const jpeg = Buffer.from(pending.subarray(0, end + 2));
        pending = pending.subarray(end + 2);
        frames.push({ offset: (frames.length) * intervalSeconds, data: jpeg });
        if (frames.length >= maxFrames) {
          capped = true;
          child.kill('SIGTERM');
          return;
        }
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Error(`Timeout extraindo frames de ${path.basename(file)}`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      consume();
    });
    child.stderr.on('data', chunk => {
      const current = errors.reduce((sum, item) => sum + item.length, 0);
      if (current < 65536) errors.push(chunk);
    });
    child.on('error', finish);
    child.on('close', code => {
      if (done) return;
      consume();
      if ((code === 0 || capped) && frames.length) return finish();
      const detail = Buffer.concat(errors).toString('utf8').trim().slice(-800);
      finish(Error(`FFmpeg não extraiu frames de ${path.basename(file)}${detail ? ': ' + detail : ''}`));
    });
  });
}

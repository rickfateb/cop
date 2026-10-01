import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor, detectChannel } from '../src/ingest.js';
import { isExtractableVideo, samplingConfig } from '../src/video.js';
import { buildPlaybackUrl } from '../src/playback.js';

test('detects explicit camera/channel tokens without guessing bare numbers', () => {
  assert.equal(detectChannel('abc/channel01/2026-09-30/foto.jpg'), 1);
  assert.equal(detectChannel('abc/CH-08/image.jpg'), 8);
  assert.equal(detectChannel('abc/camera_16/file.jpg'), 16);
  assert.equal(detectChannel('d71e617fa7a5/192.168.5.102/2026-10-01/002/MHDX_ch2_main_20261001000001_20261001000259.dav'), 2);
  assert.equal(detectChannel('abc/2026/09/30/001.jpg'), null);
});

test('maps common Intelbras media extensions', () => {
  assert.equal(contentTypeFor('foto.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('video.dav'), 'application/octet-stream');
  assert.equal(contentTypeFor('clip.mp4'), 'video/mp4');
});


test('identifies video files eligible for AI frame extraction', () => {
  assert.equal(isExtractableVideo('clip.dav'), true);
  assert.equal(isExtractableVideo('clip.MP4'), true);
  assert.equal(isExtractableVideo('foto.jpg'), false);
});


test('uses 3-second default sampling for motion video', () => {
  assert.deepEqual(samplingConfig({}), { intervalSeconds: 3, maxFrames: 600, width: 640 });
  assert.deepEqual(
    samplingConfig({ frame_interval_seconds: 4, max_ai_frames_per_video: 300, ai_frame_width: 800 }),
    { intervalSeconds: 4, maxFrames: 300, width: 800 }
  );
});


test('builds Intelbras historical playback URL', () => {
  const url=buildPlaybackUrl({host:'192.168.1.108',port:554,channel:2,start:'2026-09-29T22:23:00.000Z',end:'2026-09-29T22:38:00.000Z'});
  assert.match(url,/^rtsp:\/\/192\.168\.1\.108:554\/cam\/playback\?channel=2&starttime=2026_09_29_19_23_00&endtime=2026_09_29_19_38_00$/);
});

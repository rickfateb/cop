import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor, detectChannel } from '../src/ingest.js';
import { isExtractableVideo } from '../src/video.js';

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

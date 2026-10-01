import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor, detectChannel } from '../src/ingest.js';

test('detects explicit camera/channel tokens without guessing bare numbers', () => {
  assert.equal(detectChannel('abc/channel01/2026-09-30/foto.jpg'), 1);
  assert.equal(detectChannel('abc/CH-08/image.jpg'), 8);
  assert.equal(detectChannel('abc/camera_16/file.jpg'), 16);
  assert.equal(detectChannel('abc/2026/09/30/001.jpg'), null);
});

test('maps common Intelbras media extensions', () => {
  assert.equal(contentTypeFor('foto.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('video.dav'), 'application/octet-stream');
  assert.equal(contentTypeFor('clip.mp4'), 'video/mp4');
});

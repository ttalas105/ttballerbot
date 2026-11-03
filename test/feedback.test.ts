import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadErrorAudio } from '../src/voice/feedback.js';
import { wav } from '../src/voice/capture.js';

test('offline feedback loads bounded speech and safely falls back for missing or malformed files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ttballer-feedback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.method(console, 'warn', () => {});
  const path = join(directory, 'notice.wav'), pcm = Buffer.alloc(48000, 10);
  assert.equal(loadErrorAudio(''), undefined);
  assert.equal(loadErrorAudio(path), undefined);
  writeFileSync(path, wav(pcm, 24000)); assert.deepEqual(loadErrorAudio(path), pcm);
  writeFileSync(path, wav(pcm, 16000)); assert.equal(loadErrorAudio(path), undefined);
  writeFileSync(path, wav(Buffer.alloc(24000 * 2 * 9), 24000)); assert.equal(loadErrorAudio(path), undefined);
  writeFileSync(path, wav(Buffer.alloc(0), 24000)); assert.equal(loadErrorAudio(path), undefined);
  writeFileSync(path, 'broken'); assert.equal(loadErrorAudio(path), undefined);
});

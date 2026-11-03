import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { MODEL_NAME } from '../src/voice/wake.js';

const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${MODEL_NAME}.tar.bz2`;
// Pinned to the bytes retrieved from the upstream release when this model was integrated.
const sha256 = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a';
await mkdir('.runtime', { recursive: true }); await mkdir('models', { recursive: true });
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
const data = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('Model checksum mismatch. Nothing extracted.');
await writeFile('.runtime/wake-model.tar.bz2', data);
const listing = execFileSync('tar', ['-tf', '.runtime/wake-model.tar.bz2'], { encoding: 'utf8' });
if (listing.split(/\r?\n/).filter(Boolean).some(path => !path.startsWith(`${MODEL_NAME}/`) || path.split('/').includes('..'))) throw new Error('Unsafe model archive.');
execFileSync('tar', ['-xf', '.runtime/wake-model.tar.bz2', '-C', 'models']);
await readFile(`models/${MODEL_NAME}/tokens.txt`);
console.log('Local Hey Rajan model installed. No microphone or Discord audio was accessed.');

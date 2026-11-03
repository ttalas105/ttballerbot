import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

const filename = process.platform === 'win32' && process.arch === 'x64' ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos'
  : process.platform === 'linux' && process.arch === 'x64' ? 'yt-dlp_linux'
  : process.platform === 'linux' && process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : '';
if (!filename) throw new Error('Install yt-dlp for your platform from https://github.com/yt-dlp/yt-dlp/releases and set YTDLP_PATH.');
const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
console.log('Downloading yt-dlp from its official GitHub release and checking SHA-256…');
const results = await Promise.all([
  fetch(`${base}/${filename}`, { signal: AbortSignal.timeout(120_000) }),
  fetch(`${base}/SHA2-256SUMS`, { signal: AbortSignal.timeout(30_000) }),
]);
if (results.some(response => !response.ok)) throw new Error('Could not download the official yt-dlp release. Try again.');
const data = Buffer.from(await results[0]!.arrayBuffer());
const checksums = await results[1]!.text();
const expected = checksums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === filename)?.[0];
if (!expected || createHash('sha256').update(data).digest('hex') !== expected) throw new Error('yt-dlp checksum verification failed. Nothing was installed.');
const directory = resolve('bin');
await mkdir(directory, { recursive: true });
const target = resolve(directory, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
await writeFile(`${target}.download`, data);
await rename(`${target}.download`, target);
if (process.platform !== 'win32') await chmod(target, 0o755);
console.log('Verified and installed yt-dlp in bin/. FFmpeg must also be installed on PATH.');

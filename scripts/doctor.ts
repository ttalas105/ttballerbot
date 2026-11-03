import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from '../src/config.js';

const exec = promisify(execFile);
let missing = false;
for (const [label, executable, args] of [
  ['yt-dlp', config.ytdlp, ['--version']], ['FFmpeg', config.ffmpeg, ['-version']],
] as const) {
  try {
    const { stdout } = await exec(executable, [...args], { windowsHide: true, timeout: 15_000 });
    console.log(`OK ${label}: ${stdout.split('\n')[0]}`);
  } catch { missing = true; console.log(`MISSING ${label}: ${label === 'yt-dlp' ? 'npm run tools:install' : 'install FFmpeg and add it to PATH'}`); }
}
console.log(generateDependencyReport());
console.log(`Discord token: ${config.token ? 'set' : 'missing'}`);
console.log(`Discord application ID: ${config.clientId ? 'set' : 'missing'}`);
console.log(`Spotify app credentials: ${config.spotifyClientId && config.spotifyClientSecret ? 'set' : 'missing (YouTube still works)'}`);
console.log(`Spotify playlist sign-in: ${config.spotifyRefreshToken ? 'set' : 'missing (npm run spotify:login)'}`);
if (!config.token || !config.clientId) missing = true;
if (missing) process.exitCode = 1;

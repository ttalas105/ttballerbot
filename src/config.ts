import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

function positiveInt(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

const localYtdlp = resolve('bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
export const config = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  spotifyRefreshToken: process.env.SPOTIFY_REFRESH_TOKEN || '',
  spotifyRedirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/callback',
  market: process.env.SPOTIFY_MARKET || 'CA',
  messageCommands: process.env.ENABLE_MESSAGE_COMMANDS === 'true',
  prefix: process.env.COMMAND_PREFIX || '!',
  maxQueue: positiveInt('MAX_QUEUE_SIZE', 250, 1000),
  idleMs: positiveInt('IDLE_TIMEOUT_SECONDS', 180, 3600) * 1000,
  ytdlp: process.env.YTDLP_PATH || (existsSync(localYtdlp) ? localYtdlp : 'yt-dlp'),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  heyEnabled: process.env.ENABLE_HEY_BALLER === 'true',
  geminiKey: process.env.GEMINI_API_KEY || '',
  transcriptionModel: process.env.VOICE_TRANSCRIPTION_MODEL || 'gemini-3.1-flash-lite',
  speechModel: process.env.VOICE_SPEECH_MODEL || 'gemini-3.8-flash-tts',
  announcerVoice: process.env.VOICE_ANNOUNCER || 'Fenrir',
  fishKey: process.env.FISH_API_KEY || '',
  fishReferenceId: process.env.FISH_REFERENCE_ID || '',
  fishModel: process.env.FISH_SPEECH_MODEL || 's2.1-pro-free',
};

export function requireDiscordConfig(): void {
  for (const [key, value] of Object.entries({ DISCORD_TOKEN: config.token, DISCORD_CLIENT_ID: config.clientId })) {
    if (!value.trim()) throw new Error(`Set ${key} in .env first. See README.md.`);
  }
}

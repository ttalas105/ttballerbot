import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { resolve } from 'node:path';
import { ComponentType, type Message } from 'discord.js';
import type { Track } from './model.js';

GlobalFonts.registerFromPath(resolve('assets/fonts/BarlowCondensed-Bold.ttf'), 'Baller Display');
GlobalFonts.registerFromPath(resolve('assets/fonts/BarlowCondensed-Medium.ttf'), 'Baller Text');

export function uploadedArtworkUrl(message: Message | undefined, filename: string): string | undefined {
  // Components V2 can return gallery uploads in media items while the message's
  // legacy attachments collection is empty. Reuse that URL instead of reuploading.
  for (const component of message?.components || []) {
    if (component.type !== ComponentType.Container) continue;
    for (const child of component.components) {
      if (child.type !== ComponentType.MediaGallery) continue;
      const url = child.items.find(item => item.media.url.includes(`/${filename}`))?.media.url;
      if (url?.startsWith('https://')) return url;
    }
  }
  return message?.attachments?.find(file => file.name === filename)?.url;
}

async function coverBytes(url?: string): Promise<Buffer | undefined> {
  if (!url) return;
  const source = new URL(url);
  if (source.protocol !== 'https:' || source.port || source.username || source.password
    || !['i.scdn.co', 'mosaic.scdn.co', 'i.ytimg.com', 'img.youtube.com'].includes(source.hostname)) return;
  const response = await fetch(source, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) { await response.body?.cancel(); return; }
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5 * 1024 * 1024) { await reader.cancel(); return; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && ctx.measureText(`${line} ${word}`).width > width) { lines.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function fitLine(ctx: SKRSContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  const characters = Array.from(text);
  while (characters.length && ctx.measureText(`${characters.join('')}…`).width > width) characters.pop();
  return `${characters.join('')}…`;
}

export async function renderPlayerArtwork(track: Track): Promise<Buffer> {
  const canvas = createCanvas(1120, 448);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b1714'; ctx.fillRect(0, 0, 1120, 448);
  // A record-sleeve composition: real cover, oversized type, a quiet label mark.
  ctx.fillStyle = '#152b23'; ctx.fillRect(0, 0, 416, 448);
  let cover;
  try { const bytes = await coverBytes(track.thumbnail); if (bytes) cover = await loadImage(bytes); } catch { /* Artwork must never block playback. */ }
  if (cover) {
    const scale = Math.min(352 / cover.width, 352 / cover.height);
    const width = cover.width * scale, height = cover.height * scale;
    ctx.drawImage(cover, 32 + (352 - width) / 2, 48 + (352 - height) / 2, width, height);
  } else {
    ctx.fillStyle = '#19392d'; ctx.fillRect(32, 48, 352, 352);
    ctx.strokeStyle = '#3f775f'; ctx.lineWidth = 2;
    for (const radius of [140, 128, 116, 104, 92]) { ctx.beginPath(); ctx.arc(208, 224, radius, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = '#88e8b5'; ctx.beginPath(); ctx.arc(208, 224, 45, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b1714'; ctx.beginPath(); ctx.arc(208, 224, 7, 0, Math.PI * 2); ctx.fill();
  }
  const title = track.title.replace(/\s*[([]\s*(?:feat\.?|ft\.?)\s*.*$/i, '').trim() || track.title;
  let fontSize = 94;
  let lines: string[] = [];
  for (; fontSize >= 58; fontSize -= 2) {
    ctx.font = `${fontSize}px "Baller Display"`;
    lines = wrap(ctx, title.toUpperCase(), 612);
    if (lines.length <= 2 && lines.every(line => ctx.measureText(line).width <= 612)) break;
  }
  ctx.font = `${fontSize}px "Baller Display"`;
  lines = lines.slice(0, 2);
  if (wrap(ctx, title.toUpperCase(), 612).length > 2) lines[1] += '…';
  ctx.fillStyle = '#f0fff7';
  const titleTop = lines.length === 1 ? 185 : 140;
  lines.forEach((line, i) => ctx.fillText(fitLine(ctx, line, 612), 452, titleTop + i * (fontSize + 2)));
  ctx.font = '34px "Baller Text"'; ctx.fillStyle = '#bddbc9';
  ctx.fillText(fitLine(ctx, track.artist, 612), 452, titleTop + (lines.length - 1) * (fontSize + 2) + 52);
  ctx.strokeStyle = '#29483a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(452, 353); ctx.lineTo(1064, 353); ctx.stroke();
  ctx.fillStyle = '#88e8b5'; ctx.font = '34px "Baller Display"'; ctx.fillText('ttballerbot', 452, 402);
  ctx.fillStyle = '#bddbc9'; ctx.font = '24px "Baller Text"'; ctx.textAlign = 'right'; ctx.fillText('FOR THE HOMIES', 1064, 400);
  return canvas.encode('png');
}

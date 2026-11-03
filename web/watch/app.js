'use strict';
const $ = id => document.getElementById(id);
let token = '', media, frames = [], epoch = 0, sending = false, selecting = false, state, lastSent = -Infinity, initial = true;
const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
const error = message => {
  const target = token ? $('screen-error') : $('error');
  for (const id of ['error', 'screen-error']) { $(id).textContent = ''; $(id).hidden = true; }
  target.textContent = message; target.hidden = !message;
};
function controls() {
  $('choose').disabled = !token || !!media || selecting;
  $('choose').hidden = !!media;
  $('stop').hidden = !media;
  $('react').disabled = !media || !frames.length || sending || !!state?.busy || Date.now() - lastSent < 5000;
}
function render(next) {
  state = next; $('status').textContent = next.status;
  $('connection').textContent = media ? 'Sharing a window' : 'Connected to Discord';
  $('channel').textContent = next.channel;
  if (next.lastReply) $('reply').textContent = next.lastReply;
  $('expiry').textContent = `Connection ends at ${new Date(next.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, or when you leave the call.`;
  controls();
}
function stopLocal() {
  epoch++; frames = []; initial = true; lastSent = -Infinity;
  const old = media; media = undefined;
  old?.getTracks().forEach(track => track.stop());
  $('preview').srcObject = null; $('preview').hidden = true; $('empty').hidden = false; $('sharing-label').hidden = true;
  controls();
}
function reset(message) {
  token = ''; state = undefined; stopLocal();
  $('pair-form').hidden = false; $('paired').hidden = true; $('settings').disabled = true;
  $('connection').textContent = 'Not connected'; $('status').textContent = message;
  $('code').value = ''; controls();
}
async function api(path, body) {
  const current = token;
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(current ? { Authorization: `Bearer ${current}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
  const data = await response.json();
  if (!response.ok) {
    if (current === token && (response.status === 401 || /Session expired/.test(data.error))) reset(data.error);
    throw new Error(data.error || 'Connection failed. Try again.');
  }
  return data;
}
$('pair-form').addEventListener('submit', async event => {
  event.preventDefault(); error(''); $('connect').disabled = true;
  try {
    const data = await api('pair', { code: $('code').value.trim() }); token = data.token;
    $('pair-form').hidden = true; $('paired').hidden = false; $('settings').disabled = false;
    $('mode').value = data.mode; $('interval').value = String(data.interval); render(data); $('choose').focus();
  } catch (e) { error(e.message); } finally { $('connect').disabled = false; }
});
async function stopSharing() {
  stopLocal(); $('status').textContent = 'Sharing stopped. Choose a window to resume.';
  if (token) { try { render(await api('settings', { enabled: false })); } catch (e) { error(e.message); } }
}
$('choose').addEventListener('click', async () => {
  if (!token || media || selecting) return;
  if (!navigator.mediaDevices?.getDisplayMedia) { error('Window sharing needs desktop Chrome or Edge. Open this page on the computer running the bot.'); return; }
  error(''); selecting = true; controls();
  const current = token, generation = ++epoch;
  let selected;
  try {
    // Only a real click opens the browser picker. Stream audio is never requested.
    selected = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 2, max: 5 }, width: { ideal: 1280 } }, audio: false });
    if (generation !== epoch || current !== token) { selected.getTracks().forEach(track => track.stop()); return; }
    media = selected;
    selected.getVideoTracks()[0].addEventListener('ended', () => { if (media === selected) void stopSharing(); }, { once: true });
    $('preview').srcObject = media; await $('preview').play();
    const data = await api('settings', { enabled: true });
    if (generation !== epoch || current !== token || media !== selected) return;
    $('preview').hidden = false; $('empty').hidden = true; $('sharing-label').hidden = false;
    frames = []; initial = true; lastSent = -Infinity; render(data); $('stop').focus();
  } catch (e) {
    selected?.getTracks().forEach(track => track.stop());
    await stopSharing();
    error(e.name === 'NotAllowedError' ? 'Nothing shared. Click Choose a window when you’re ready.' : 'Could not share that window. Try again with a visible game or Discord pop-out.');
  } finally { selecting = false; controls(); }
});
$('stop').addEventListener('click', () => void stopSharing());
$('disconnect').addEventListener('click', async () => {
  const request = api('stop', {}); reset('Disconnected. Run /watch mode:start for a new code.');
  try { await request; } catch (e) { error(e.message); }
});
for (const id of ['mode', 'interval']) $(id).addEventListener('change', async () => {
  const previous = state?.[id]; $(id).disabled = true;
  try { render(await api('settings', { [id]: id === 'interval' ? Number($(id).value) : $(id).value })); }
  catch (e) { if (previous !== undefined) $(id).value = String(previous); error(e.message); }
  finally { $(id).disabled = false; }
});
async function submit(manual) {
  if (!token || !media || !frames.length || sending || state?.busy) return;
  const current = token, generation = epoch;
  const latest = frames.at(-1);
  if (Date.now() - latest.at > 2000) return;
  sending = true; lastSent = Date.now(); controls();
  try {
    const data = await api('frames', { frames: frames.map(frame => frame.data), capturedAt: latest.at, manual });
    if (current === token && generation === epoch) { initial = false; render(data); error(''); }
  } catch (e) { error(e.message); }
  finally { sending = false; controls(); }
}
$('react').addEventListener('click', () => void submit(true));
// Two recent small frames preserve motion context; no video upload or frame backlog.
setInterval(() => {
  if (!media || !state?.enabled || $('preview').readyState < 2) return;
  const video = $('preview');
  if (!video.videoWidth || !video.videoHeight) return;
  const scale = Math.min(1, 832 / video.videoWidth, 468 / video.videoHeight);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  frames.push({ data: canvas.toDataURL('image/jpeg', .65).split(',')[1], at: Date.now() }); frames = frames.slice(-2);
  controls();
  if (frames.length === 2 && !selecting && !state.busy && state.interval && (initial || Date.now() - lastSent >= state.interval * 1000)) void submit(initial);
}, 650);
let polling = false, failures = 0;
setInterval(async () => {
  controls(); if (!token || polling) return;
  polling = true; const current = token;
  try { const data = await api('status'); if (current === token) { failures = 0; render(data); } }
  catch (e) { if (current === token) { error(e.message); if (++failures >= 3) reset('Lost the bot connection. Run /watch mode:stop, then /watch mode:start to reconnect.'); } }
  finally { polling = false; }
}, 2000);
addEventListener('pagehide', () => {
  if (token) void fetch('/api/stop', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
  token = ''; stopLocal();
});

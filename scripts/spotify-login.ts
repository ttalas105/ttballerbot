import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../src/config.js';
import { saveEnv } from './env.js';

if (!config.spotifyClientId || !config.spotifyClientSecret) throw new Error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.');
const redirect = new URL(config.spotifyRedirectUri);
if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.username || redirect.password) {
  throw new Error('Use a loopback redirect, such as http://127.0.0.1:8888/callback.');
}
const state = randomBytes(32).toString('hex');
const verifier = randomBytes(48).toString('base64url');
let exchanging = false;
const server = createServer((request, response) => {
  void (async () => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.url || '/', redirect.origin);
    if (url.pathname !== redirect.pathname) { response.writeHead(404).end('Not found.'); return; }
    const supplied = Buffer.from(url.searchParams.get('state') || '');
    const expected = Buffer.from(state);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(400).end('Invalid login state. Run npm run spotify:login again.'); return;
    }
    if (url.searchParams.has('error')) { response.writeHead(400).end('Spotify sign-in was declined. Close this tab.'); finish(); return; }
    const code = url.searchParams.get('code');
    if (!code || exchanging) { response.writeHead(400).end('Missing or already-used authorization code.'); return; }
    exchanging = true;
    const result = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect.href, code_verifier: verifier }),
    });
    const tokens = await result.json() as { refresh_token?: string };
    if (!result.ok || !tokens.refresh_token) {
      response.writeHead(400).end('Spotify sign-in failed. Check the redirect URI and app settings, then try again.');
      process.exitCode = 1; finish(); return;
    }
    saveEnv({ SPOTIFY_REFRESH_TOKEN: tokens.refresh_token });
    response.end('ttballerbot is connected to Spotify. Credentials were saved locally. You can close this tab and restart the bot.');
    console.log('Spotify connected. Refresh token saved to .env (not printed). Restart the bot to apply it.');
    finish();
  })().catch(() => { response.writeHead(500).end('Login failed. Run npm run spotify:login again.'); process.exitCode = 1; finish(); });
});
const timer = setTimeout(() => { console.log('Login timed out. Run npm run spotify:login to retry.'); finish(); }, 10 * 60_000);
function finish(): void { clearTimeout(timer); server.close(); }
server.on('error', () => { console.error('Could not start the local callback server. Check whether the redirect port is in use.'); clearTimeout(timer); process.exitCode = 1; });
server.listen(Number(redirect.port), '127.0.0.1', () => {
  const authorize = new URL('https://accounts.spotify.com/authorize');
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: config.spotifyClientId,
    redirect_uri: redirect.href, scope: 'playlist-read-private playlist-read-collaborative', state,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  console.log(`Open this link in your browser:\n${authorize.href}\nWaiting up to 10 minutes for sign-in…`);
});

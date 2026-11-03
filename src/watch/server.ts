import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UserError, logError, userMessage } from '../model.js';
import { WatchManager } from './manager.js';

export class WatchServer {
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private attempts = 0;
  private attemptWindow = 0;
  private port = 0;
  constructor(private readonly manager: WatchManager, private readonly assetRoot = resolve('web/watch')) {
    this.server.requestTimeout = 10000; this.server.headersTimeout = 5000; this.server.maxConnections = 32;
  }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  async start(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.port = (this.server.address() as { port: number }).port;
    this.server.on('error', error => logError('spectator server', error));
  }
  close(): Promise<void> { this.server.closeAllConnections(); return new Promise(resolve => this.server.close(() => resolve())); }
  private json(response: ServerResponse, code: number, data: unknown): void {
    response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
  }
  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new UserError('Send a JSON request.');
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1100000) throw new UserError('Screenshot upload is too large.');
      chunks.push(Buffer.from(chunk));
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new UserError('Invalid request.'); }
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src data:; media-src blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const host = request.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) { this.json(response, 403, { error: 'Local connections only.' }); return; }
    if (request.headers.origin && request.headers.origin !== `http://${host}`) { this.json(response, 403, { error: 'Open the companion directly on this computer.' }); return; }
    const path = new URL(request.url || '/', this.url).pathname;
    try {
      const files: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
      };
      if (request.method === 'GET' && (files[path] || path === '/font.ttf')) {
        const [name, type] = files[path] || ['', 'font/ttf'];
        const bytes = await readFile(path === '/font.ttf' ? resolve('assets/fonts/BarlowCondensed-Bold.ttf') : resolve(this.assetRoot, name));
        response.writeHead(200, { 'Content-Type': type }); response.end(bytes); return;
      }
      if (request.method === 'POST' && request.headers.origin !== `http://${host}`) { this.json(response, 403, { error: 'Use the companion window to control sharing.' }); return; }
      if (path === '/api/pair' && request.method === 'POST') {
        if (Date.now() - this.attemptWindow > 60000) { this.attemptWindow = Date.now(); this.attempts = 0; }
        if (++this.attempts > 8) { this.json(response, 429, { error: 'Too many attempts. Wait a minute, then use a new Discord code.' }); return; }
        const body = await this.body(request);
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new UserError('Enter the six-digit code from /watch mode:start.');
        this.json(response, 200, this.manager.pair(body.code)); return;
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1];
      if (!token) { this.json(response, 401, { error: 'Connect with the code from Discord first.' }); return; }
      // Authenticate before accepting a potentially large screenshot body.
      const state = this.manager.status(token);
      if (path === '/api/status' && request.method === 'GET') { this.json(response, 200, state); return; }
      if (path === '/api/settings' && request.method === 'POST') { this.json(response, 200, this.manager.configure(token, await this.body(request))); return; }
      if (path === '/api/frames' && request.method === 'POST') { this.json(response, 202, this.manager.submit(token, await this.body(request))); return; }
      if (path === '/api/stop' && request.method === 'POST') { this.manager.stopToken(token); this.json(response, 200, { stopped: true }); return; }
      this.json(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) this.json(response, error instanceof UserError ? 400 : 500, { error: userMessage(error) });
      if (!(error instanceof UserError)) logError('spectator HTTP', error);
    }
  }
}

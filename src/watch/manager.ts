import { createHash, randomBytes, randomInt } from 'node:crypto';
import { UserError, logError, userMessage } from '../model.js';
import { validateFrames, watchModes, type ScreenReaction, type WatchMode } from './frames.js';

export interface WatchTarget {
  guildId: string; userId: string; channelName: string;
  valid(): boolean;
  busy(): boolean;
  react(frames: string[], mode: WatchMode, history: ScreenReaction[], manual: boolean, signal: AbortSignal): Promise<ScreenReaction | undefined>;
  onStop(): void;
}
interface WatchSession {
  id: string; code: string; token?: string; target: WatchTarget;
  expires: number; heartbeat: number; enabled: boolean; mode: WatchMode; interval: number;
  status: string; lastReply: string; lastAttempt: number; hash: string; history: ScreenReaction[];
  job?: AbortController;
}

export class WatchManager {
  private readonly sessions = new Map<string, WatchSession>();
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly now = Date.now) { this.timer = setInterval(() => this.prune(), 2000); this.timer.unref(); }
  create(target: WatchTarget): { id: string; code: string } {
    this.prune();
    if (this.sessions.has(target.guildId)) throw new UserError('A spectator session already exists. Use /watch mode:stop first.');
    if (this.sessions.size >= 20) throw new UserError('This host has too many spectator sessions. Try later.');
    let code: string;
    do { code = String(randomInt(100000, 1000000)); } while ([...this.sessions.values()].some(session => session.code === code));
    const session: WatchSession = { id: randomBytes(12).toString('hex'), code, target, expires: this.now() + 120000, heartbeat: this.now(),
      enabled: false, mode: 'roast', interval: 30000, status: 'Choose a window to start watching.', lastReply: '', lastAttempt: -Infinity, hash: '', history: [] };
    this.sessions.set(target.guildId, session); return { id: session.id, code };
  }
  private find(token: string): WatchSession {
    this.prune();
    const session = [...this.sessions.values()].find(item => item.token && item.token === token);
    if (!session) throw new UserError('Session expired. Run /watch mode:start in Discord to reconnect.');
    session.heartbeat = this.now(); return session;
  }
  pair(code: string) {
    this.prune();
    const session = [...this.sessions.values()].find(item => !item.token && item.code === code);
    if (!session) throw new UserError('That code expired or was already used. Run /watch mode:start again.');
    session.token = randomBytes(32).toString('hex'); session.code = ''; session.expires = this.now() + 30 * 60000; session.heartbeat = this.now();
    return { token: session.token, ...this.snapshot(session) };
  }
  private snapshot(session: WatchSession) {
    return { channel: session.target.channelName, enabled: session.enabled, mode: session.mode, interval: session.interval / 1000,
      busy: !!session.job, status: session.status, lastReply: session.lastReply, expiresAt: session.expires };
  }
  status(token: string) { return this.snapshot(this.find(token)); }
  configure(token: string, input: { mode?: unknown; interval?: unknown; enabled?: unknown }) {
    const session = this.find(token);
    if (input.mode !== undefined && !watchModes.includes(input.mode as WatchMode)) throw new UserError('Choose Roast, Hype or Commentary.');
    if (input.interval !== undefined && ![15, 30, 60, 0].includes(input.interval as number)) throw new UserError('Choose a listed reaction frequency.');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new UserError('Invalid sharing state.');
    if (input.mode !== undefined && input.mode !== session.mode) {
      session.job?.abort(); session.job = undefined; session.mode = input.mode as WatchMode;
      session.hash = ''; session.lastAttempt = -Infinity;
      session.status = 'Reaction style updated. Waiting for a fresh scene.';
    }
    if (input.interval !== undefined) session.interval = Number(input.interval) * 1000;
    if (input.enabled !== undefined) {
      session.job?.abort(); session.job = undefined; session.enabled = input.enabled as boolean;
      session.hash = ''; session.lastAttempt = -Infinity;
      session.status = session.enabled ? 'Watching. Waiting for a moment worth reacting to.' : 'Sharing stopped. Choose a window to resume.';
    }
    return this.snapshot(session);
  }
  submit(token: string, input: { frames?: unknown; capturedAt?: unknown; manual?: unknown }) {
    const session = this.find(token);
    if (!session.enabled) throw new UserError('Choose a window before requesting a reaction.');
    if (typeof input.capturedAt !== 'number' || Math.abs(this.now() - input.capturedAt) > 5000) throw new UserError('Those frames are stale. Capture the current window again.');
    if (input.manual !== undefined && typeof input.manual !== 'boolean') throw new UserError('Invalid reaction request.');
    if (session.job) return this.snapshot(session);
    const manual = input.manual === true;
    if ((!manual && !session.interval) || this.now() - session.lastAttempt < (manual ? 5000 : session.interval)) return this.snapshot(session);
    if (session.target.busy()) { session.status = 'Waiting for Rajan’s current request to finish.'; return this.snapshot(session); }
    const frames = validateFrames(input.frames), hash = createHash('sha256').update(frames.join('')).digest('hex');
    if (!manual && hash === session.hash) { session.status = 'The scene hasn’t changed. Still watching.'; return this.snapshot(session); }
    session.hash = hash; session.lastAttempt = this.now(); session.status = 'Reading the scene…';
    const job = new AbortController(); session.job = job;
    const deadline = AbortSignal.timeout(30000), signal = AbortSignal.any([job.signal, deadline]);
    void session.target.react(frames, session.mode, session.history.slice(-3), manual, signal).then(reaction => {
      if (signal.aborted || session.job !== job || !session.target.valid()) return;
      if (reaction?.react) {
        session.lastReply = reaction.reply; session.history.push(reaction); session.history = session.history.slice(-3);
        session.status = 'Watching for the next moment.';
      } else session.status = reaction ? 'Nothing new to call out. Still watching.' : 'Conversation took priority. Watching for the next moment.';
    }).catch(error => {
      if (job.signal.aborted || session.job !== job) return;
      session.status = deadline.aborted ? 'That moment passed while the AI was responding. Try React now.' : userMessage(error);
      logError('spectator reaction', error);
    }).finally(() => {
      if (session.job === job) {
        if (deadline.aborted) session.status = 'That moment passed while the AI was responding. Try React now.';
        session.job = undefined;
      }
    });
    return this.snapshot(session);
  }
  stopToken(token: string): void { this.stop(this.find(token).target.guildId); }
  active(guildId: string): boolean { this.prune(); return this.sessions.has(guildId); }
  id(guildId: string): string | undefined { this.prune(); return this.sessions.get(guildId)?.id; }
  stop(guildId: string): void {
    const session = this.sessions.get(guildId); if (!session) return;
    this.sessions.delete(guildId); session.job?.abort(); session.history = [];
    session.target.onStop();
  }
  prune(): void {
    for (const [guildId, session] of this.sessions) {
      if (this.now() >= session.expires || (session.token && this.now() - session.heartbeat > 15000) || !session.target.valid()) this.stop(guildId);
    }
  }
  close(): void { clearInterval(this.timer); for (const id of this.sessions.keys()) this.stop(id); }
}

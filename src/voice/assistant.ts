import { Worker } from 'node:worker_threads';
import { EndBehaviorType, VoiceConnectionStatus, type AudioReceiveStream } from '@discordjs/voice';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type GuildMember, type Message } from 'discord.js';
import { MusicSession } from '../session.js';
import { SerialExecutor } from '../queue.js';
import { UserError, VoiceError, logError, userMessage } from '../model.js';
import { Speech } from './speech.js';
import { parseVoiceIntent, entranceLine, weddingLine, type Person, type VoiceDecision } from './intents.js';
import { effectPcm } from './effects.js';
import { VoiceMemory } from './memory.js';

export interface VoiceActions { play(query: string, userId: string, signal: AbortSignal): Promise<string> }

export class HeyBaller {
  readonly members = new Map<string, AudioReceiveStream>();
  private worker?: Worker;
  private ready?: Promise<void>;
  private active?: { userId: string; controller: AbortController };
  private message?: Message;
  private pending = new Map<string, number>();
  private readonly panelSerial = new SerialExecutor();
  private expiry?: NodeJS.Timeout;
  private closed = false;
  private generation = 0;
  private status = 'Off';
  private lastRequest = new Map<string, number>();
  private execution?: AbortController;
  private executionUser?: string;
  private readonly memory = new VoiceMemory();
  private readonly speakingEnd = (userId: string) => {
    if (this.members.has(userId)) this.worker?.postMessage({ type: 'silence', userId });
  };
  constructor(readonly session: MusicSession, private readonly speech: Speech, private readonly actions?: VoiceActions, private readonly threshold = 0.3) {}

  private people(): Person[] {
    return [...this.session.voice?.members.values() || []].filter(member => !member.user.bot)
      .map(member => ({ id: member.id, name: member.displayName, aliases: [member.user.username, member.user.globalName || ''].filter(Boolean) }));
  }
  private async init(): Promise<void> {
    if (this.ready) return this.ready;
    const url = new URL(import.meta.url.endsWith('.ts') ? './wake-worker.ts' : './wake-worker.js', import.meta.url);
    const workerData = { threshold: this.threshold };
    // Native decoding stays off the Discord heartbeat/audio scheduling thread.
    this.worker = url.pathname.endsWith('.ts')
      ? new Worker(`import('tsx/esm/api').then(({register})=>{register();return import(${JSON.stringify(url.href)})})`, { eval: true, workerData })
      : new Worker(url, { workerData });
    const worker = this.worker;
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new UserError('The local wake detector did not start. Run npm run voice:install and restart.')), 20000);
      const startupError = () => { clearTimeout(timeout); reject(new UserError('The local wake detector could not load. Run npm run voice:install.')); };
      worker.once('error', startupError);
      worker.once('message', message => {
        clearTimeout(timeout); worker.off('error', startupError);
        if (message.type === 'ready') resolve(); else reject(new UserError('Wake detector startup failed.'));
      });
    });
    worker.on('message', message => {
      if (message.type === 'ack') { if (this.members.has(message.userId)) this.pending.set(message.userId, Math.max(0, (this.pending.get(message.userId) || 1) - 1)); return; }
      if (message.type === 'decodeError') return;
      if (message.type === 'wake') void this.wake(message.userId).catch(error => { this.cancel(); this.report(error); });
      if (message.type === 'command') void this.command(message.userId, message.pcm && Buffer.from(message.pcm)).catch(error => this.report(error));
    });
    worker.on('error', error => { logError('wake worker', error); this.close('Wake detector stopped. Use /hey on to retry.'); });
    worker.on('exit', () => { if (!this.closed) this.close('Wake detector stopped. Use /hey on to retry.'); });
    try { await this.ready; } catch (error) { this.close('Wake detector unavailable.'); throw error; }
  }

  async enable(member: GuildMember): Promise<void> {
    this.session.assertMember(member);
    if (this.closed) throw new UserError('This voice session ended. Use /hey on again.');
    if (this.members.has(member.id)) return;
    if (this.members.size >= 4) throw new UserError('This first version supports four opted-in listeners at once.');
    await this.init();
    this.session.assertMember(member);
    // Publish disclosure before reception begins. An unsuccessful notice must not enable listening.
    this.status = `Enabling for ${member.displayName}`;
    await this.publish();
    const connection = this.session.connection!;
    if (!this.members.size) connection.receiver.speaking.on('end', this.speakingEnd);
    connection.rejoin({ ...connection.joinConfig, selfDeaf: false });
    const stream = connection.receiver.subscribe(member.id, { end: { behavior: EndBehaviorType.Manual } });
    this.members.set(member.id, stream); this.pending.set(member.id, 0);
    this.worker!.postMessage({ type: 'add', userId: member.id });
    stream.on('data', (packet: Buffer) => {
      if (this.closed || !this.members.has(member.id)) return;
      if ((this.pending.get(member.id) || 0) >= 100) { this.remove(member.id); this.status = 'Voice processing fell behind. Please enable again.'; void this.publish().catch(logError.bind(null, 'voice panel')); return; }
      this.pending.set(member.id, (this.pending.get(member.id) || 0) + 1);
      this.worker?.postMessage({ type: 'audio', userId: member.id, packet });
    });
    stream.on('error', error => { logError('voice receive', error); this.remove(member.id); });
    this.status = this.speech.configured ? 'Say “Hey Baller”, wait for the chime, then speak.' : 'Wake test ready. Commands need a Gemini API key; /effect dramatic works now.';
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.close('Listening expired after 15 minutes. Use /hey on again.'), 15 * 60000); this.expiry.unref();
    await this.publish();
  }
  remove(userId: string): void {
    this.members.get(userId)?.destroy(); this.members.delete(userId); this.pending.delete(userId);
    this.memory.remove(userId); this.lastRequest.delete(userId);
    this.worker?.postMessage({ type: 'remove', userId });
    if (this.active?.userId === userId || this.executionUser === userId) this.cancel();
    if (!this.members.size) this.close('Listening is off.');
    else void this.publish().catch(logError.bind(null, 'voice panel'));
  }
  prune(): void {
    for (const id of this.members.keys()) if (!this.session.voice?.members.has(id)) this.remove(id);
    for (const id of this.lastRequest.keys()) if (!this.session.voice?.members.has(id)) { this.memory.remove(id); this.lastRequest.delete(id); }
    if (this.executionUser && !this.session.voice?.members.has(this.executionUser)) this.cancel();
  }
  cancel(): void {
    this.generation++; this.active?.controller.abort(); this.active = undefined;
    this.execution?.abort(); this.execution = undefined; this.executionUser = undefined;
    for (const userId of this.members.keys()) this.worker?.postMessage({ type: 'cancel', userId });
    this.session.stopEffect();
    this.status = this.members.size ? 'Stopped. Ready for “Hey Baller”.' : 'Assistant stopped.';
    void this.publish().catch(logError.bind(null, 'voice panel'));
  }
  private rearm(): void {
    if (this.closed || this.active || this.execution || this.session.effectPlaying) return;
    // Drop detections made during a reply and reset the worker's wake cooldown.
    for (const userId of this.members.keys()) this.worker?.postMessage({ type: 'cancel', userId });
  }
  private async wake(userId: string): Promise<void> {
    if (this.closed || !this.members.has(userId) || this.active || this.execution || this.session.effectPlaying) return;
    const request = { userId, controller: new AbortController() }; this.active = request;
    this.status = `Heard “Hey Baller” from ${this.people().find(person => person.id === userId)?.name || 'a listener'}.`;
    void this.publish().catch(logError.bind(null, 'voice panel'));
    await this.session.playEffect(effectPcm('chime'), request.controller.signal);
    if (request.controller.signal.aborted || this.closed) return;
    if (!this.speech.configured) {
      this.active = undefined; this.status = 'Wake phrase detected! Configure GEMINI_API_KEY to enable spoken commands.';
      this.rearm(); await this.publish(); return;
    }
    this.status = 'Listening for a command… (up to 8 seconds)';
    this.worker?.postMessage({ type: 'capture', userId });
    await this.publish();
  }
  private async command(userId: string, pcm?: Buffer): Promise<void> {
    const request = this.active;
    if (!request || request.userId !== userId || this.closed || !this.members.has(userId)) return;
    try {
      if (!pcm) throw new VoiceError('I didn’t hear a request. Say “Hey Baller” and speak after the chime.', 'VOICE_EMPTY_COMMAND');
      await this.execute(pcm, userId, request.controller.signal);
    } catch (error) { if (!request.controller.signal.aborted) this.report(error); }
    finally { if (this.active === request) this.active = undefined; this.rearm(); }
  }
  async execute(input: string | Buffer, userId: string, signal = new AbortController().signal): Promise<void> {
    if (this.closed || this.session.closed || !this.session.voice?.members.has(userId)) throw new UserError('Join the bot’s voice channel first.');
    const local = typeof input === 'string' ? parseVoiceIntent(input, this.people(), userId) : undefined;
    if (local?.kind === 'stop') { this.cancel(); await this.publish(); return; }
    if (this.execution || (this.active && (typeof input === 'string' || this.active.userId !== userId))) throw new VoiceError('I’m handling another request. Use /hey mode:stop to cancel it.', 'VOICE_BUSY');
    if (Date.now() - (this.lastRequest.get(userId) || 0) < 2000) throw new VoiceError('Give the previous request a moment, then try again.', 'VOICE_COOLDOWN');
    if (this.session.effectPlaying) throw new VoiceError('I’m speaking or playing an effect. Use the Stop response button to interrupt.', 'VOICE_BUSY');
    this.lastRequest.set(userId, Date.now());
    const execution = new AbortController(); this.execution = execution; this.executionUser = userId;
    signal = AbortSignal.any([signal, execution.signal]);
    const started = Date.now();
    try {
      const generation = this.generation;
      this.status = 'Thinking…'; void this.publish().catch(logError.bind(null, 'voice panel'));
      // One multimodal request understands the audio AND prepares a conversational reply.
      const decision: VoiceDecision = local && local.kind !== 'chat' ? { transcript: String(input).slice(0, 500), intent: local }
        : await this.speech.understand(input, this.people(), userId, this.memory.get(userId), signal);
      if (signal.aborted || generation !== this.generation || this.closed || !this.session.voice?.members.has(userId)) return;
      const { intent } = decision;
      console.log(`${new Date().toISOString()} [hey baller] action=${intent.kind} understoodMs=${Date.now() - started}`);
      let response = '';
      if (intent.kind === 'stop') { this.cancel(); await this.publish(); return; }
      if (intent.kind === 'music') {
        if (!this.actions) throw new VoiceError('Music requests aren’t connected on this host. Use /play.', 'VOICE_MUSIC_UNAVAILABLE');
        this.status = 'Finding your music…'; void this.publish().catch(logError.bind(null, 'voice panel'));
        response = await this.actions.play(intent.query, userId, signal);
      } else if (['pause', 'resume', 'skip', 'back', 'shuffle', 'stop_music'].includes(intent.kind)) {
        await this.session.serial.run(() => {
          signal.throwIfAborted();
          const member = this.session.voice?.members.get(userId);
          if (!member) throw new UserError('Join the bot’s voice channel first.');
          this.session.assertMember(member);
          this.session.control(intent.kind === 'skip' ? 'next' : intent.kind === 'stop_music' ? 'stop' : intent.kind);
        });
        response = ({ pause: 'Music paused.', resume: 'Music resumed.', skip: 'Skipped to the next song.', back: 'Going back.', shuffle: 'Queue shuffled.', stop_music: 'Music stopped.' } as Record<string, string>)[intent.kind]!;
      } else if (intent.kind === 'say' || intent.kind === 'entrance' || intent.kind === 'wedding') {
        response = intent.kind === 'say' ? intent.reply : intent.kind === 'wedding' ? weddingLine(intent.name) : entranceLine(intent.name);
        this.status = intent.kind === 'say' ? 'Getting my voice ready…' : `Preparing ${intent.name}’s ${intent.kind}…`;
        void this.publish().catch(logError.bind(null, 'voice panel'));
        const speech = await this.speech.speak(response, signal, intent.kind === 'say' ? 'conversation' : intent.kind);
        if (signal.aborted || generation !== this.generation || this.closed || !this.session.voice?.members.has(userId)) return;
        this.status = intent.kind === 'say' ? 'Speaking…' : 'Announcing…'; void this.publish().catch(logError.bind(null, 'voice panel'));
        await this.session.playEffect(effectPcm(intent.kind === 'say' ? 'speech' : intent.kind, speech), signal);
      } else if (intent.kind === 'dramatic' || intent.kind === 'airhorn') {
        this.status = `Playing ${intent.kind}…`; void this.publish().catch(logError.bind(null, 'voice panel'));
        await this.session.playEffect(effectPcm(intent.kind), signal); response = `Played ${intent.kind}.`;
      }
      if (signal.aborted || generation !== this.generation || this.closed) return;
      this.memory.add(userId, decision.transcript, response);
      console.log(`${new Date().toISOString()} [hey baller] completed=${intent.kind} totalMs=${Date.now() - started}`);
      this.status = `${intent.kind === 'music' || ['pause', 'resume', 'skip', 'back', 'shuffle'].includes(intent.kind) ? `${response}\n\n` : ''}${this.members.size ? 'Ready. Say “Hey Baller” for your next request.' : 'Ready for /ask or /effect. Voice listening is off.'}`;
      await this.publish();
    } catch (error) {
      if (!signal.aborted && typeof input === 'string') this.report(error);
      throw error;
    } finally {
      if (this.execution === execution) { this.execution = undefined; this.executionUser = undefined; }
      this.rearm();
    }
  }
  private report(error: unknown): void { logError('hey baller', error); if (this.closed) return; this.status = userMessage(error); void this.publish().catch(logError.bind(null, 'voice panel')); }
  async publish(): Promise<void> {
    await this.panelSerial.run(async () => {
      const enabled = this.members.size > 0;
      const embed = new EmbedBuilder().setColor(enabled ? 0x88e8b5 : 0x52685c).setTitle('HEY BALLER • your voice assistant')
        .setDescription(this.status).addFields({ name: enabled ? 'Listening locally for the wake phrase' : 'Voice listening is off',
          value: enabled ? [...this.members.keys()].map(id => `<@${id}>`).join(' · ') : 'Use /hey on to opt in for your own voice.' },
        { name: 'Try saying', value: '“Play some J Cole” · “Tell me a joke” · “Announce Tyrone like a wedding” · “Dramatic soundtrack” · “Pause the music”' },
        { name: 'Your voice, your choice', value: 'Only opted-in voices are checked locally. After the chime, up to 8 seconds go to Gemini. Your last 4 requests and replies stay in memory for 10 minutes for follow-ups and are sent with your next request. No recordings or transcripts are saved to disk. Opt-out clears your context. Google’s free tier may use requests to improve its products. Replies use an AI voice.' })
        .setFooter({ text: 'Hey Baller → chime → speak • Wake again for each reply • 15-minute opt-in • /ask works without listening' });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`tth:${this.session.id}:off`).setLabel('Stop listening to me').setStyle(ButtonStyle.Secondary).setDisabled(!enabled),
        new ButtonBuilder().setCustomId(`tth:${this.session.id}:stop`).setLabel('Stop response').setStyle(ButtonStyle.Danger).setDisabled(this.closed),
        new ButtonBuilder().setCustomId(`tth:${this.session.id}:alloff`).setLabel('Turn listening off').setStyle(ButtonStyle.Secondary).setDisabled(!enabled));
      const payload = { embeds: [embed], components: [row], allowedMentions: { parse: [] as [] } };
      if (this.message) {
        try { this.message = await this.message.edit(payload); return; } catch (error) { if ((error as { code?: number }).code !== 10008) throw error; }
      }
      if (!this.closed) this.message = await this.session.text.send(payload);
    });
  }
  get ended(): boolean { return this.closed; }
  get busy(): boolean { return !!this.active || !!this.execution || this.session.effectPlaying; }
  close(reason = 'Voice listening and effects are off.'): void {
    if (this.closed) return;
    this.closed = true; this.cancel(); clearTimeout(this.expiry);
    for (const stream of this.members.values()) stream.destroy();
    this.members.clear(); this.pending.clear(); this.memory.clear(); this.lastRequest.clear();
    void this.worker?.terminate(); this.worker = undefined;
    const connection = this.session.connection;
    connection?.receiver.speaking.off('end', this.speakingEnd);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed && !this.session.closed) connection.rejoin({ ...connection.joinConfig, selfDeaf: true });
    this.status = reason; void this.publish().catch(logError.bind(null, 'voice panel'));
    if (!this.session.queue.size && !this.session.closed) this.session.close('Voice effects session ended.');
  }
}

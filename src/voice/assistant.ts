import { Worker } from 'node:worker_threads';
import { EndBehaviorType, VoiceConnectionStatus, type AudioReceiveStream } from '@discordjs/voice';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type GuildMember, type Message } from 'discord.js';
import { MusicSession } from '../session.js';
import { SerialExecutor } from '../queue.js';
import { UserError, logError, userMessage } from '../model.js';
import { Speech } from './speech.js';
import { parseVoiceIntent, entranceLine, type Person } from './intents.js';
import { effectPcm } from './effects.js';

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
  private readonly speakingEnd = (userId: string) => {
    if (this.members.has(userId)) this.worker?.postMessage({ type: 'silence', userId });
  };
  constructor(readonly session: MusicSession, private readonly speech: Speech, private readonly threshold = 0.3) {}

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
      if (message.type === 'wake') void this.wake(message.userId).catch(error => this.report(error));
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
    this.worker?.postMessage({ type: 'remove', userId });
    if (this.active?.userId === userId) this.cancel();
    if (!this.members.size) this.close('Listening is off.');
    else void this.publish().catch(logError.bind(null, 'voice panel'));
  }
  prune(): void { for (const id of this.members.keys()) if (!this.session.voice?.members.has(id)) this.remove(id); }
  cancel(): void {
    this.generation++; this.active?.controller.abort(); this.active = undefined;
    this.execution?.abort(); this.execution = undefined;
    for (const userId of this.members.keys()) this.worker?.postMessage({ type: 'cancel', userId });
    this.session.stopEffect();
  }
  private async wake(userId: string): Promise<void> {
    if (this.closed || !this.members.has(userId) || this.active || this.session.effectPlaying) return;
    const request = { userId, controller: new AbortController() }; this.active = request;
    this.status = `Heard “Hey Baller” from ${this.people().find(person => person.id === userId)?.name || 'a listener'}.`;
    void this.publish().catch(logError.bind(null, 'voice panel'));
    await this.session.playEffect(effectPcm('chime'), request.controller.signal);
    if (request.controller.signal.aborted || this.closed) return;
    if (!this.speech.configured) {
      this.active = undefined; this.status = 'Wake phrase detected! Configure GEMINI_API_KEY to enable spoken commands.';
      await this.publish(); return;
    }
    this.status = 'Listening for a command… (up to 8 seconds)';
    this.worker?.postMessage({ type: 'capture', userId });
    await this.publish();
  }
  private async command(userId: string, pcm?: Buffer): Promise<void> {
    const request = this.active;
    if (!request || request.userId !== userId || this.closed || !this.members.has(userId)) return;
    try {
      if (!pcm) throw new UserError('I didn’t hear a command. Say “Hey Baller” and speak after the chime.');
      this.status = 'Understanding the command…'; void this.publish().catch(logError.bind(null, 'voice panel'));
      const text = await this.speech.transcribe(pcm, this.people().map(person => person.name), request.controller.signal);
      if (request.controller.signal.aborted || !this.members.has(userId)) return;
      await this.execute(text, userId, request.controller.signal);
    } catch (error) { if (!request.controller.signal.aborted) this.report(error); }
    finally { if (this.active === request) this.active = undefined; }
  }
  async execute(text: string, userId: string, signal = new AbortController().signal): Promise<void> {
    if (this.closed || this.session.closed || !this.session.voice?.members.has(userId)) throw new UserError('Join the bot’s voice channel first.');
    const intent = parseVoiceIntent(text, this.people());
    if (intent.kind === 'stop') { this.cancel(); this.status = 'Effects stopped.'; await this.publish(); return; }
    if (this.execution) throw new UserError('Another effect is being prepared. Use /hey stop to cancel.');
    if (Date.now() - (this.lastRequest.get(userId) || 0) < 5000) throw new UserError('Give the previous command a moment.');
    if (this.session.effectPlaying) throw new UserError('An effect is playing. Use /hey stop to interrupt it.');
    this.lastRequest.set(userId, Date.now());
    const execution = new AbortController(); this.execution = execution;
    signal = AbortSignal.any([signal, execution.signal]);
    try {
      const generation = this.generation;
      this.status = intent.kind === 'entrance' ? `Preparing ${intent.name}’s AI entrance…` : `Playing ${intent.kind}…`;
      await this.publish();
      const speech = intent.kind === 'entrance' ? await this.speech.speak(entranceLine(intent.name), signal) : undefined;
      if (signal.aborted || generation !== this.generation || this.closed || !this.session.voice?.members.has(userId)) return;
      await this.session.playEffect(effectPcm(intent.kind, speech), signal);
      if (signal.aborted || generation !== this.generation || this.closed) return;
      this.status = this.members.size ? 'Ready. Say “Hey Baller”.' : 'Ready for /effect. Voice listening is off.';
      await this.publish();
    } finally { if (this.execution === execution) this.execution = undefined; }
  }
  private report(error: unknown): void { logError('hey baller', error); if (this.closed) return; this.active = undefined; this.status = userMessage(error); void this.publish().catch(logError.bind(null, 'voice panel')); }
  async publish(): Promise<void> {
    await this.panelSerial.run(async () => {
      const enabled = this.members.size > 0;
      const embed = new EmbedBuilder().setColor(enabled ? 0x88e8b5 : 0x52685c).setTitle('HEY BALLER • voice effects')
        .setDescription(this.status).addFields({ name: enabled ? 'Listening locally for the wake phrase' : 'Voice listening is off',
          value: enabled ? [...this.members.keys()].map(id => `<@${id}>`).join(' · ') : 'Use /hey on to opt in for your own voice.' },
        { name: 'How it works', value: 'Only opted-in voices are checked locally. After the chime, up to 8 seconds of your command go to Google Gemini. This bot saves no voice recordings or transcripts. Google’s free tier may use requests to improve its products. Announcer speech is AI-generated.' })
        .setFooter({ text: 'Say “Hey Baller” → wait for chime → dramatic soundtrack / air horn / announce a name • 15-minute sessions' });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`tth:${this.session.id}:off`).setLabel('Stop listening to me').setStyle(ButtonStyle.Secondary).setDisabled(!enabled),
        new ButtonBuilder().setCustomId(`tth:${this.session.id}:stop`).setLabel('Stop effects').setStyle(ButtonStyle.Danger).setDisabled(this.closed),
        new ButtonBuilder().setCustomId(`tth:${this.session.id}:alloff`).setLabel('Turn listening off').setStyle(ButtonStyle.Secondary).setDisabled(!enabled));
      const payload = { embeds: [embed], components: [row], allowedMentions: { parse: [] as [] } };
      if (this.message) {
        try { this.message = await this.message.edit(payload); return; } catch (error) { if ((error as { code?: number }).code !== 10008) throw error; }
      }
      if (!this.closed) this.message = await this.session.text.send(payload);
    });
  }
  get ended(): boolean { return this.closed; }
  close(reason = 'Voice listening and effects are off.'): void {
    if (this.closed) return;
    this.closed = true; this.cancel(); clearTimeout(this.expiry);
    for (const stream of this.members.values()) stream.destroy();
    this.members.clear(); this.pending.clear();
    void this.worker?.terminate(); this.worker = undefined;
    const connection = this.session.connection;
    connection?.receiver.speaking.off('end', this.speakingEnd);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed && !this.session.closed) connection.rejoin({ ...connection.joinConfig, selfDeaf: true });
    this.status = reason; void this.publish().catch(logError.bind(null, 'voice panel'));
    if (!this.session.queue.size && !this.session.closed) this.session.close('Voice effects session ended.');
  }
}

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import {
  AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus, createAudioPlayer,
  entersState, joinVoiceChannel, createAudioResource, StreamType, type AudioResource, type VoiceConnection,
} from '@discordjs/voice';
import { AttachmentBuilder, ChannelType, PermissionFlagsBits, type GuildMember, type GuildTextBasedChannel, type Message, type VoiceChannel } from 'discord.js';
import { MusicQueue, SerialExecutor } from './queue.js';
import { buildPanel, type PanelState } from './panel.js';
import { PlaybackError, UserError, logError, userMessage, type Track } from './model.js';
import type { PreparedAudio, YouTube } from './youtube.js';
import { renderPlayerArtwork, uploadedArtworkUrl } from './artwork.js';

export function requireVoice(member: GuildMember): VoiceChannel {
  const channel = member.voice.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new UserError('Join a regular voice channel first, then use /play.');
  return channel;
}

export function createMusicPlayer(noSubscriber = NoSubscriberBehavior.Pause) {
  // The library default gives up after just 100 ms without an audio packet.
  return createAudioPlayer({ behaviors: { noSubscriber, maxMissedFrames: 250 } });
}

export class MusicSession {
  readonly id = randomBytes(6).toString('hex');
  readonly queue: MusicQueue;
  readonly serial = new SerialExecutor();
  readonly player = createMusicPlayer();
  status: PanelState['status'] = 'idle';
  notice?: string;
  message?: Message;
  connection?: VoiceConnection;
  voice?: VoiceChannel;
  closed = false;
  private audio?: PreparedAudio;
  private controller?: AbortController;
  private generation = 0;
  private resumeOffset = 0;
  private retries = 0;
  private pauseRequested = false;
  private idleTimer?: NodeJS.Timeout;
  private emptyTimer?: NodeJS.Timeout;
  private panelTimer: NodeJS.Timeout;
  private readonly panelSerial = new SerialExecutor();
  private artwork?: { trackId: string; name: string; buffer: Buffer };
  private finishEffect?: () => void;
  get effectPlaying(): boolean { return !!this.finishEffect; }

  /** Temporarily pause the queue, play an effect, then restore the same music resource. */
  async playEffect(pcm: Buffer, signal?: AbortSignal): Promise<void> {
    if (this.closed || !this.connection || signal?.aborted) return;
    this.stopEffect();
    const generation = this.generation;
    const wasPlaying = this.status === 'playing';
    if (wasPlaying) { this.player.pause(); this.status = 'paused'; }
    const effect = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    const input = Readable.from([pcm]);
    const resource = createAudioResource(input, { inputType: StreamType.Raw });
    await new Promise<void>(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        clearTimeout(timeout); signal?.removeEventListener('abort', finish);
        this.finishEffect = undefined; effect.stop(true); input.destroy(); resource.playStream.destroy();
        if (!this.closed && this.connection?.state.status !== VoiceConnectionStatus.Destroyed) {
          this.connection?.subscribe(this.player);
          if (wasPlaying && generation === this.generation && !this.pauseRequested) { this.player.unpause(); this.status = 'playing'; }
        }
        this.refresh(); resolve();
      };
      const timeout = setTimeout(finish, 32000); timeout.unref();
      this.finishEffect = finish;
      effect.once(AudioPlayerStatus.Idle, finish);
      effect.once('error', error => { logError('sound effect', error); finish(); });
      signal?.addEventListener('abort', finish, { once: true });
      this.connection!.subscribe(effect); effect.play(resource); this.refresh();
    });
  }
  stopEffect(): void { this.finishEffect?.(); }

  constructor(
    readonly text: GuildTextBasedChannel, private readonly youtube: YouTube,
    capacity: number, private readonly idleMs: number, private readonly onClose: () => void,
  ) {
    this.queue = new MusicQueue(capacity);
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing && this.audio?.resource === newState.resource && !this.closed) {
        if (this.pauseRequested) this.player.pause();
        this.status = this.pauseRequested ? 'paused' : 'playing';
        this.refresh();
      }
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        const resource = oldState.resource;
        void this.serial.run(() => {
          if (this.closed || this.audio?.resource !== resource) return;
          const played = this.resumeOffset + resource.playbackDuration / 1000;
          const track = this.queue.current;
          const expected = track?.playbackDurationSeconds || track?.durationSeconds || 0;
          if (expected && played < expected - Math.max(3, expected * 0.02)) {
            this.recoverPlayback(new PlaybackError('The audio stream ended before the song finished.', 'AUDIO_EARLY_END'), played);
          } else { this.queue.next(); this.startCurrent(); }
        }).catch(error => logError('track completion', error));
      }
    });
    this.player.on('error', error => {
      void this.serial.run(() => {
        if (this.closed || this.audio?.resource !== error.resource) return;
        this.recoverPlayback(error.resource.playStream.errored || error, this.resumeOffset + error.resource.playbackDuration / 1000);
      }).catch(err => logError('audio recovery', err));
    });
    this.panelTimer = setInterval(() => this.refresh(), 15_000);
    this.panelTimer.unref();
  }

  assertMember(member: GuildMember): VoiceChannel {
    if (this.closed) throw new UserError('That session ended. Use /play to start a new one.');
    const channel = requireVoice(member);
    if (this.voice && channel.id !== this.voice.id) throw new UserError('Join the bot’s voice channel to change its queue or playback.');
    return channel;
  }

  async connect(member: GuildMember): Promise<void> {
    const voice = this.assertMember(member);
    if (this.connection?.state.status === VoiceConnectionStatus.Ready) return;
    const me = member.guild.members.me || await member.guild.members.fetchMe();
    if (!voice.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new UserError('I need View Channel, Connect, and Speak permissions in your voice channel.');
    }
    if (voice.full && !voice.permissionsFor(me)?.has(PermissionFlagsBits.MoveMembers)) throw new UserError('That voice channel is full.');
    const textPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
      this.text.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages];
    if (!this.text.permissionsFor(me)?.has(textPermissions)) throw new UserError('I need View Channel, Send Messages, Embed Links, and Read Message History in this text channel.');
    this.voice = voice;
    this.connection = joinVoiceChannel({ channelId: voice.id, guildId: member.guild.id, adapterCreator: member.guild.voiceAdapterCreator, selfDeaf: true });
    const connection = this.connection;
    connection.subscribe(this.player);
    connection.on('error', error => { logError('voice connection', error); this.close('Voice connection failed. Use /play to reconnect.'); });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void (async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        } catch { if (!this.closed) this.close('Disconnected from voice. Use /play to start again.'); }
      })();
    });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
    catch { this.close('Could not connect to voice.'); throw new UserError('I could not join voice. Check voice permissions and outbound UDP/network access.'); }
    // The requester might have left while Discord was connecting.
    this.assertMember(member);
    this.checkListeners();
  }

  add(tracks: Track[]): void {
    this.queue.add(tracks);
    this.notice = undefined;
    if (!this.queue.current) { this.queue.next(); this.startCurrent(); }
    else this.refresh();
  }

  private releaseAudio(): void {
    this.generation++;
    this.stopEffect();
    this.controller?.abort();
    this.controller = undefined;
    const oldAudio = this.audio;
    this.audio = undefined; // Ignore Idle/error events from the resource being replaced.
    this.player.stop(true);
    oldAudio?.dispose();
  }

  private recoverPlayback(error: unknown, played: number): void {
    logError(`playback at ${Math.floor(played)}s; retry ${this.retries}/2`, error);
    if (this.retries < 2) {
      this.retries++;
      this.notice = `Stream interrupted. Reconnecting to the same song (${this.retries}/2)…`;
      this.startCurrent(Math.max(0, played - 0.25), true);
    } else {
      this.notice = `Skipped ${this.queue.current?.title || 'a song'} after 2 retries: ${userMessage(error)}`;
      this.queue.next();
      this.startCurrent();
    }
  }

  private startCurrent(startAtSeconds = 0, recovering = false): void {
    if (this.closed) return;
    this.releaseAudio();
    this.resumeOffset = startAtSeconds;
    if (!recovering) { this.retries = 0; this.pauseRequested = false; }
    clearTimeout(this.idleTimer);
    const track = this.queue.current;
    if (!track) {
      this.status = 'idle';
      this.idleTimer = setTimeout(() => this.close('The queue finished. See you next time.'), this.idleMs);
      this.idleTimer.unref();
      this.refresh();
      return;
    }
    this.status = 'loading';
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.refresh();
    void (async () => {
      try {
        if (recovering) await delay(this.retries * 1000, undefined, { signal: controller.signal });
        const audio = await this.youtube.prepare(track, controller.signal, startAtSeconds);
        await this.serial.run(() => {
          if (this.closed || generation !== this.generation) { audio.dispose(); return; }
          this.audio = audio;
          this.status = 'loading';
          this.player.play(audio.resource);
          this.refresh();
        });
      } catch (error) {
        await this.serial.run(() => {
          if (this.closed || generation !== this.generation || controller.signal.aborted) return;
          if (recovering) { this.recoverPlayback(error, startAtSeconds); return; }
          this.notice = `Skipped ${track.title}: ${userMessage(error)}`;
          logError('track preparation', error);
          this.queue.next();
          this.startCurrent();
        });
      }
    })().catch(error => logError('playback task', error));
  }

  control(action: string): void {
    if (this.closed) throw new UserError('That session has ended.');
    if (this.effectPlaying && ['toggle', 'pause', 'resume'].includes(action)) this.stopEffect();
    switch (action) {
      case 'next': this.queue.next(); this.startCurrent(); break;
      case 'back': this.queue.previous(); this.startCurrent(); break;
      case 'pause':
      case 'resume':
      case 'toggle': {
        if (!this.queue.current || this.status === 'loading') throw new UserError('Wait for a song to start playing first.');
        const shouldPause = action === 'pause' || (action === 'toggle' && this.status !== 'paused');
        this.pauseRequested = shouldPause;
        if (shouldPause) { this.player.pause(); this.status = 'paused'; }
        else { this.player.unpause(); this.status = 'playing'; }
        this.refresh();
        break;
      }
      case 'shuffle': this.queue.shuffle(); this.refresh(); break;
      case 'clear': this.queue.clear(); this.refresh(); break;
      case 'stop': this.close('Stopped by a listener.'); break;
      default: throw new UserError('Unknown player control.');
    }
  }

  checkListeners(): void {
    if (this.closed || !this.voice) return;
    if (this.voice.members.some(member => !member.user.bot)) {
      clearTimeout(this.emptyTimer); this.emptyTimer = undefined;
    } else if (!this.emptyTimer) {
      this.emptyTimer = setTimeout(() => this.close('Everyone left the voice channel.'), Math.min(this.idleMs, 60_000));
      this.emptyTimer.unref();
    }
  }

  async publish(): Promise<void> {
    await this.panelSerial.run(async () => {
      const current = this.queue.current;
      const me = this.text.guild?.members.me;
      const canAttach = !!me && !!this.text.permissionsFor(me)?.has(PermissionFlagsBits.AttachFiles);
      if (current && canAttach && this.artwork?.trackId !== current.id) {
        const buffer = await renderPlayerArtwork(current);
        if (current !== this.queue.current) return;
        this.artwork = { trackId: current.id, name: `player-${current.id}.png`, buffer };
      }
      const art = current && canAttach && this.artwork?.trackId === current.id ? this.artwork : undefined;
      const artworkUrl = art ? uploadedArtworkUrl(this.message, art.name) : undefined;
      const resource: AudioResource<Track> | undefined = this.audio?.resource;
      const panelState: PanelState = { id: this.id, queue: this.queue, status: this.status,
        elapsed: this.resumeOffset + (resource?.playbackDuration || 0) / 1000, voiceId: this.voice?.id, notice: this.notice,
        artworkUrl: art ? artworkUrl || `attachment://${art.name}` : undefined };
      const payload = buildPanel(panelState);
      const files = art && !artworkUrl ? { files: [new AttachmentBuilder(art.buffer, { name: art.name })], attachments: [] } : art ? {} : { attachments: [] };
      if (this.message) {
        try { this.message = await this.message.edit({ ...payload, ...files }); return; }
        catch (error) {
          if ((error as { code?: number }).code !== 10008) throw error;
          this.message = undefined;
        }
      }
      if (!this.closed) this.message = await this.text.send({
        ...buildPanel({ ...panelState, artworkUrl: art ? `attachment://${art.name}` : undefined }),
        ...(art ? { files: [new AttachmentBuilder(art.buffer, { name: art.name })] } : {}),
      });
    });
  }

  refresh(): void { void this.publish().catch(error => logError('queue panel', error)); }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseAudio();
    clearInterval(this.panelTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.emptyTimer);
    this.queue.reset();
    this.status = 'stopped';
    this.notice = reason;
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    this.onClose();
    this.refresh();
  }
}

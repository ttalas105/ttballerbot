import { ActionRowBuilder, ActivityType, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, type GuildMember, type GuildTextBasedChannel, type Message } from 'discord.js';
import { config, requireDiscordConfig } from './config.js';
import { help } from './commands.js';
import { MusicSession, requireVoice } from './session.js';
import { Spotify } from './spotify.js';
import { YouTube } from './youtube.js';
import { parseInput } from './input.js';
import { UserError, logError, userMessage, type ImportResult } from './model.js';
import { addSongModal, clean, queuePage } from './panel.js';
import { saveEnv } from '../scripts/env.js';
import { HeyRajan } from './voice/assistant.js';
import { Speech } from './voice/speech.js';
import { configuredFishVoice } from './voice/fish.js';
import { loadErrorAudio } from './voice/feedback.js';
import { WatchManager } from './watch/manager.js';
import { WatchServer } from './watch/server.js';

requireDiscordConfig();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages,
    ...(config.messageCommands ? [GatewayIntentBits.MessageContent] : [])],
  allowedMentions: { parse: [], repliedUser: false },
});
const spotify = new Spotify({ clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret,
  refreshToken: config.spotifyRefreshToken, market: config.market,
  onRefreshToken: token => saveEnv({ SPOTIFY_REFRESH_TOKEN: token }),
  privatePlaylistUsers: (process.env.SPOTIFY_PRIVATE_PLAYLIST_USERS || '').split(',').map(id => id.trim()).filter(Boolean),
});
const youtube = new YouTube(config.ytdlp, config.ffmpeg);
const sessions = new Map<string, MusicSession>();
const assistants = new Map<string, HeyRajan>();
const fish = configuredFishVoice(config);
const speech = new Speech(config.geminiKey, config.transcriptionModel, config.speechModel, config.announcerVoice, undefined, fish, loadErrorAudio(config.voiceErrorAudio), config.watchModel);
const importing = new Map<string, { controller: AbortController; voiceId: string }>();
const watchers = new WatchManager();
let watchServer: WatchServer | undefined;
if (config.watchEnabled) {
  const server = new WatchServer(watchers);
  try { await server.start(config.watchPort); watchServer = server; console.log(`Rajan spectator companion: ${server.url}`); }
  catch (error) { logError('spectator startup', error); }
}

function sessionFor(member: GuildMember, channel: GuildTextBasedChannel): MusicSession {
  let session = sessions.get(member.guild.id);
  if (!session) {
    session = new MusicSession(channel, youtube, config.maxQueue, config.idleMs, () => {
      if (sessions.get(member.guild.id) === session) {
        watchers.stop(member.guild.id);
        assistants.get(member.guild.id)?.close(); assistants.delete(member.guild.id);
        sessions.delete(member.guild.id);
      }
    });
    sessions.set(member.guild.id, session);
  }
  return session;
}

async function voiceAction(member: GuildMember, channel: GuildTextBasedChannel, mode: string, prompt?: string): Promise<string> {
  if (!config.heyEnabled) throw new UserError('Hey Rajan is disabled. The host can enable it with ENABLE_HEY_BALLER=true.');
  let assistant = assistants.get(member.guild.id);
  if (mode === 'status') {
    if (!assistant || assistant.ended) return 'Hey Rajan is off. /hey mode:on opts in only your own voice.';
    await assistant.publish(); return `Voice assistant: <#${assistant.session.text.id}>. ${assistant.members.size} opted-in listener(s).`;
  }
  const voice = requireVoice(member);
  if (assistant && !assistant.ended && assistant.session.voice?.id !== voice.id) throw new UserError('Join the bot’s voice channel first.');
  if (['off', 'alloff', 'stop'].includes(mode)) {
    if (!assistant || assistant.ended) return 'Hey Rajan is already off.';
    if (mode === 'off') assistant.remove(member.id);
    else if (mode === 'alloff') assistant.close();
    else assistant.cancel();
    return mode === 'stop' ? 'Assistant response stopped.' : 'Listening updated.';
  }
  const session = sessionFor(member, channel);
  await session.serial.run(async () => {
    session.assertMember(member); await session.connect(member);
    if (!assistant || assistant.ended) {
      assistant = new HeyRajan(session, speech, { play: async (query, userId, signal) => {
        signal.throwIfAborted();
        const requester = session.voice?.members.get(userId);
        if (!requester) throw new UserError('Join the bot’s voice channel first.');
        return play(requester, session.text, query, signal);
      } });
      assistants.set(member.guild.id, assistant);
    }
    if (mode === 'on') await assistant.enable(member);
  });
  if (mode === 'effect' || mode === 'ask') {
    try { await assistant!.execute(prompt || '', member.id); }
    finally { if (!assistant!.busy && !assistant!.members.size && !session.queue.size && !watchers.active(member.guild.id)) session.close('Assistant request finished.'); }
  }
  return mode === 'on' ? 'Enabled for your voice for 15 minutes. Say “Hey Rajan”, wait for the chime, then ask anything, request music, or an effect. Wake again for each request. /hey mode:off opts out.' : 'Request complete.';
}

async function watchAction(member: GuildMember, channel: GuildTextBasedChannel, mode: string): Promise<string> {
  if (mode === 'stop') {
    sessions.get(member.guild.id)?.assertMember(member);
    watchers.stop(member.guild.id); return 'Screen reactions stopped.';
  }
  if (!watchServer) throw new UserError('The screen-sharing companion is not enabled on this host.');
  if (!speech.configured) throw new UserError('Screen reactions need the host’s Gemini key.');
  if (watchers.active(member.guild.id)) throw new UserError('A spectator session is already open. Use /watch mode:stop first.');
  await voiceAction(member, channel, 'watch');
  const assistant = assistants.get(member.guild.id)!, session = assistant.session;
  session.assertMember(member); const voiceId = session.voice!.id;
  let notice: Message | undefined;
  const ticket = watchers.create({ guildId: member.guild.id, userId: member.id, channelName: session.voice!.name,
    valid: () => !session.closed && !assistant.ended && session.voice?.id === voiceId && !!session.voice.members.has(member.id),
    busy: () => assistant.busy,
    react: (frames, mode, history, manual, signal) => assistant.reactToStream(frames, mode, history, manual, member.id, signal),
    onStop: () => {
      session.holdForWatch(false);
      void notice?.delete().catch(error => { if ((error as {code?: number}).code !== 10008) logError('spectator notice', error); });
      if (!session.closed && !assistant.members.size && !assistant.busy && !session.queue.size) session.close('Screen reactions stopped.');
    },
  });
  session.holdForWatch(true);
  try {
    notice = await channel.send({ content: `**Rajan spectator** · <@${member.id}> is connecting a shared window.\nSelected images go to Gemini for AI reactions. No stream audio or microphone is captured; frames are not saved locally. Google’s free tier may use submitted images to improve its products. Reactions use Rajan’s AI voice and may contain profanity.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`ttw:${ticket.id}:stop`).setLabel('Stop watching').setStyle(ButtonStyle.Danger))], allowedMentions: { parse: [] } });
    if (watchers.id(member.guild.id) !== ticket.id) { await notice.delete(); throw new UserError('You left voice before pairing. Join again and use /watch mode:start.'); }
  } catch (error) { watchers.stop(member.guild.id); throw error; }
  return `Open ${watchServer.url} **on the computer running this bot** and enter **${ticket.code}** within two minutes. Then select the game/video window, or a friend’s Discord stream pop-out.\nChoose Roast, Hype or Commentary and a reaction frequency. The connection lasts up to 30 minutes; stopping the share cancels pending reactions.`;
}

async function play(member: GuildMember, channel: GuildTextBasedChannel, query: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const voice = requireVoice(member);
  sessions.get(member.guild.id)?.assertMember(member);
  if (importing.has(member.guild.id)) throw new UserError('Another song or playlist is being added. Give it a moment.');
  const importRequest = { controller: new AbortController(), voiceId: voice.id };
  importing.set(member.guild.id, importRequest);
  try {
    let input = parseInput(query);
    if (input.kind === 'spotify-short') input = await spotify.expandShortLink(input.url);
    const existing = sessions.get(member.guild.id);
    const available = config.maxQueue - (existing?.queue.size || 0);
    if (available <= 0) throw new UserError('The queue is full. Remove or skip a song first.');
    let result: ImportResult;
    if (input.kind === 'spotify') result = await spotify.import(input, member.id, available);
    else if (input.kind === 'youtube' || input.kind === 'search') {
      const track = await youtube.lookup(input.kind === 'youtube' ? input.url : input.query, member.id);
      result = { tracks: [track], label: track.title };
    } else throw new UserError('Use the full Spotify link.');
    if (signal?.aborted || importRequest.controller.signal.aborted) throw new UserError('The import was cancelled. Nothing was added.');
    // Stop cancels an in-progress import for an existing session.
    if (existing && existing.closed) throw new UserError('The session stopped while importing; nothing was added.');
    requireVoice(member);
    const session = sessionFor(member, channel);
    const target = session;
    try {
      await target.serial.run(async () => {
        signal?.throwIfAborted();
        if (importRequest.controller.signal.aborted) throw new UserError('The import was cancelled. Nothing was added.');
        target.assertMember(member);
        await target.connect(member);
        signal?.throwIfAborted();
        if (importRequest.controller.signal.aborted) throw new UserError('The import was cancelled. Nothing was added.');
        target.add(result.tracks);
        await target.publish();
      });
    } catch (error) {
      if (!target.queue.size) target.close('Could not start the session.');
      throw error;
    }
    return `Queued **${result.tracks.length} ${result.tracks.length === 1 ? 'song' : 'songs'}** from **${clean(result.label, 100)}**.${result.notice ? `\n${result.notice}` : ''}\nPlayer: <#${target.text.id}>`;
  } finally { importing.delete(member.guild.id); }
}

function getSession(guildId: string): MusicSession {
  const session = sessions.get(guildId);
  if (!session || session.closed) throw new UserError('There is no active session. Join voice and use /play.');
  return session;
}

async function action(member: GuildMember, name: string, position?: number): Promise<string> {
  if (name === 'stop') {
    const pending = importing.get(member.guild.id);
    if (pending) {
      if (requireVoice(member).id !== pending.voiceId) throw new UserError('Join the requesting voice channel to cancel this import.');
      pending.controller.abort();
      if (!sessions.has(member.guild.id)) return 'Cancelled the pending import.';
    }
  }
  const session = getSession(member.guild.id);
  return session.serial.run(() => {
    session.assertMember(member);
    if (name === 'remove') {
      const track = session.queue.remove(position || 0);
      session.refresh();
      return `Removed **${clean(track.title)}**.`;
    }
    session.control(name === 'skip' ? 'next' : name);
    return ({ pause: 'Paused.', resume: 'Resumed.', skip: 'Skipped.', back: 'Going back.', shuffle: 'Shuffled upcoming songs.', clear: 'Cleared upcoming songs.', stop: 'Stopped and left voice.' } as Record<string, string>)[name] || 'Updated.';
  });
}

client.on(Events.InteractionCreate, interaction => {
  void (async () => {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'Use this bot in a server.', flags: MessageFlags.Ephemeral }); return;
    }
    try {
      if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith('ttadd:')) return;
        const session = getSession(interaction.guildId);
        if (interaction.customId !== `ttadd:${session.id}`) throw new UserError('That player has ended. Use /play to start a new session.');
        session.assertMember(interaction.member);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(await play(interaction.member, session.text, interaction.fields.getTextInputValue('query')));
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith('ttw:')) {
          const [, id] = interaction.customId.split(':');
          const session = getSession(interaction.guildId); session.assertMember(interaction.member);
          if (watchers.id(interaction.guildId) !== id) throw new UserError('That spectator session has ended.');
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          watchers.stop(interaction.guildId); await interaction.editReply('Screen reactions stopped.'); return;
        }
        if (interaction.customId.startsWith('tth:')) {
          const [, id, mode] = interaction.customId.split(':');
          const assistant = assistants.get(interaction.guildId);
          if (!assistant || assistant.ended || assistant.session.id !== id) throw new UserError('That voice effects session ended. Use /hey mode:on.');
          assistant.session.assertMember(interaction.member);
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await interaction.editReply(await voiceAction(interaction.member, assistant.session.text, mode || 'status')); return;
        }
        if (interaction.customId.startsWith('ttq:')) {
          const [, id, page] = interaction.customId.split(':');
          const session = getSession(interaction.guildId);
          if (session.id !== id) throw new UserError('That queue has expired. Open the current player.');
          await interaction.update(queuePage(session.queue, Number(page) || 1, session.id));
          return;
        }
        if (!interaction.customId.startsWith('ttb:')) return;
        const [, id, name] = interaction.customId.split(':');
        const session = getSession(interaction.guildId);
        if (session.id !== id || session.message?.id !== interaction.message.id) throw new UserError('That player card has expired. Use /nowplaying for the current card.');
        if (name === 'queue') {
          await interaction.reply({ ...queuePage(session.queue, 1, session.id), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
          return;
        }
        session.assertMember(interaction.member);
        if (name === 'add') { await interaction.showModal(addSongModal(session.id)); return; }
        await interaction.deferUpdate();
        await session.serial.run(() => { session.assertMember(interaction.member); session.control(name || ''); });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const name = interaction.commandName;
      if (name === 'watch') {
        const channel = interaction.channel;
        if (!channel || channel.isDMBased() || !channel.isTextBased()) throw new UserError('Use a server text channel.');
        await interaction.editReply(await watchAction(interaction.member, channel, interaction.options.getString('mode', true))); return;
      }
      if (name === 'hey' || name === 'effect' || name === 'ask') {
        const channel = interaction.channel;
        if (!channel || channel.isDMBased() || !channel.isTextBased()) throw new UserError('Use a server text channel.');
        await interaction.editReply(await voiceAction(interaction.member, channel,
          name === 'hey' ? interaction.options.getString('mode', true) : name, interaction.options.getString('prompt') || undefined)); return;
      }
      if (name === 'help') { await interaction.editReply(help.replace('!play', `${config.prefix}play`)); return; }
      if (name === 'queue') {
        const session = getSession(interaction.guildId);
        await interaction.editReply(queuePage(session.queue, interaction.options.getInteger('page') || 1, session.id)); return;
      }
      if (name === 'nowplaying') {
        const session = getSession(interaction.guildId);
        await session.publish();
        await interaction.editReply(`Player: ${session.message?.url || `<#${session.text.id}>`}`); return;
      }
      if (name === 'play') {
        const channel = interaction.channel;
        if (!channel || channel.isDMBased() || !channel.isTextBased()) throw new UserError('Use a server text channel.');
        await interaction.editReply(await play(interaction.member, channel, interaction.options.getString('query', true))); return;
      }
      await interaction.editReply(await action(interaction.member, name, interaction.options.getInteger('position') || undefined));
    } catch (error) {
      logError('interaction', error);
      const content = userMessage(error);
      if (interaction.isButton() && interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  })().catch(error => logError('interaction response', error));
});

client.on(Events.MessageCreate, message => {
  void (async () => {
    if (message.author.bot || !message.inGuild() || !message.member) return;
    const mention = new RegExp(`^<@!?${client.user!.id}>\\s*`);
    const raw = config.messageCommands && message.content.startsWith(config.prefix) ? message.content.slice(config.prefix.length)
      : mention.test(message.content) ? message.content.replace(mention, '') : null;
    if (raw === null) return;
    let [command = '', ...args] = raw.trim().split(/\s+/);
    if (/^(?:<?https:\/\/|spotify:)/i.test(command)) { args = [command, ...args]; command = 'play'; }
    const name = ({ p: 'play', q: 'queue', next: 'skip', previous: 'back', leave: 'stop' } as Record<string, string>)[command.toLowerCase()] || command.toLowerCase();
    try {
      if (name === 'help' || !name) { await message.reply(help.replace('!play', `${config.prefix}play`)); return; }
      if (name === 'play') {
        await message.channel.sendTyping();
        await message.reply(await play(message.member, message.channel, args.join(' '))); return;
      }
      if (name === 'queue') {
        const session = getSession(message.guildId);
        await message.reply(queuePage(session.queue, Number(args[0]) || 1, session.id)); return;
      }
      if (name === 'nowplaying') {
        const session = getSession(message.guildId); await session.publish();
        await message.reply(`Player: ${session.message?.url || `<#${session.text.id}>`}`); return;
      }
      if (!['pause', 'resume', 'skip', 'back', 'shuffle', 'remove', 'clear', 'stop'].includes(name)) return;
      await message.reply(await action(message.member, name, Number(args[0])));
    } catch (error) { logError('message command', error); await message.reply(userMessage(error)); }
  })().catch(error => logError('message response', error));
});

client.on(Events.VoiceStateUpdate, (_oldState, state) => {
  const session = sessions.get(state.guild.id);
  if (!session) return;
  if (state.id === client.user?.id && session.voice && state.channelId !== session.voice.id) {
    session.close('The bot was moved or disconnected. Use /play in the new channel.'); return;
  }
  session.checkListeners();
  assistants.get(state.guild.id)?.prune();
  watchers.prune();
});
client.once(Events.ClientReady, ready => {
  console.log(`ttballerbot online as ${ready.user.tag} in ${ready.guilds.cache.size} server(s).`);
  ready.user.setActivity('/play • music with the homies', { type: ActivityType.Listening });
  void ready.application.fetch().then(app => {
    const owner = app.owner;
    const ownerId = owner ? ('ownerId' in owner ? owner.ownerId : owner.id) : null;
    if (ownerId) spotify.allowPrivatePlaylistsFor(ownerId);
  }).catch(error => logError('bot owner lookup', error));
});
client.on(Events.Error, error => logError('Discord client', error));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  watchers.close(); void watchServer?.close();
  for (const session of sessions.values()) session.close('Bot is restarting.');
  setTimeout(() => { client.destroy(); process.exit(0); }, 1500).unref();
});
try { await client.login(config.token); }
catch {
  console.error('Discord login failed. Check DISCORD_TOKEN. If using ! commands, enable Message Content Intent in the developer portal, or set ENABLE_MESSAGE_COMMANDS=false.');
  client.destroy(); process.exitCode = 1;
}

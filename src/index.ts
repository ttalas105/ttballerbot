import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { config, requireDiscordConfig } from './config.js';
import { help } from './commands.js';
import { MusicSession, requireVoice } from './session.js';
import { Spotify } from './spotify.js';
import { YouTube } from './youtube.js';
import { parseInput } from './input.js';
import { UserError, logError, userMessage, type ImportResult } from './model.js';
import { addSongModal, clean, queuePage } from './panel.js';
import { saveEnv } from '../scripts/env.js';
import { HeyBaller } from './voice/assistant.js';
import { Speech } from './voice/speech.js';

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
const assistants = new Map<string, HeyBaller>();
const speech = new Speech(config.geminiKey, config.transcriptionModel, config.speechModel, config.announcerVoice);
const importing = new Map<string, { controller: AbortController; voiceId: string }>();

function sessionFor(member: GuildMember, channel: GuildTextBasedChannel): MusicSession {
  let session = sessions.get(member.guild.id);
  if (!session) {
    session = new MusicSession(channel, youtube, config.maxQueue, config.idleMs, () => {
      if (sessions.get(member.guild.id) === session) {
        assistants.get(member.guild.id)?.close(); assistants.delete(member.guild.id);
        sessions.delete(member.guild.id);
      }
    });
    sessions.set(member.guild.id, session);
  }
  return session;
}

async function voiceAction(member: GuildMember, channel: GuildTextBasedChannel, mode: string, prompt?: string): Promise<string> {
  if (!config.heyEnabled) throw new UserError('Hey Baller is disabled. The host can enable it with ENABLE_HEY_BALLER=true.');
  let assistant = assistants.get(member.guild.id);
  if (mode === 'status') {
    if (!assistant || assistant.ended) return 'Hey Baller is off. /hey mode:on opts in only your own voice.';
    await assistant.publish(); return `Voice effects: <#${assistant.session.text.id}>. ${assistant.members.size} opted-in listener(s).`;
  }
  const voice = requireVoice(member);
  if (assistant && !assistant.ended && assistant.session.voice?.id !== voice.id) throw new UserError('Join the bot’s voice channel first.');
  if (['off', 'alloff', 'stop'].includes(mode)) {
    if (!assistant || assistant.ended) return 'Hey Baller is already off.';
    if (mode === 'off') assistant.remove(member.id);
    else if (mode === 'alloff') assistant.close();
    else assistant.cancel();
    return mode === 'stop' ? 'Effects stopped.' : 'Listening updated.';
  }
  const session = sessionFor(member, channel);
  await session.serial.run(async () => {
    session.assertMember(member); await session.connect(member);
    if (!assistant || assistant.ended) { assistant = new HeyBaller(session, speech); assistants.set(member.guild.id, assistant); }
    if (mode === 'on') await assistant.enable(member);
  });
  if (mode === 'effect') {
    try { await assistant!.execute(prompt || '', member.id); }
    finally { if (!assistant!.members.size && !session.queue.size) session.close('Sound effect finished.'); }
  }
  return mode === 'on' ? 'Enabled for your voice for 15 minutes. Say “Hey Baller”, wait for the chime, then give a command. /hey mode:off opts out.' : 'Effect complete.';
}

async function play(member: GuildMember, channel: GuildTextBasedChannel, query: string): Promise<string> {
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
    if (importRequest.controller.signal.aborted) throw new UserError('The import was cancelled. Nothing was added.');
    // Stop cancels an in-progress import for an existing session.
    if (existing && existing.closed) throw new UserError('The session stopped while importing; nothing was added.');
    requireVoice(member);
    const session = sessionFor(member, channel);
    const target = session;
    try {
      await target.serial.run(async () => {
        target.assertMember(member);
        await target.connect(member);
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
      if (name === 'hey' || name === 'effect') {
        const channel = interaction.channel;
        if (!channel || channel.isDMBased() || !channel.isTextBased()) throw new UserError('Use a server text channel.');
        await interaction.editReply(await voiceAction(interaction.member, channel,
          name === 'hey' ? interaction.options.getString('mode', true) : 'effect', interaction.options.getString('prompt') || undefined)); return;
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
  for (const session of sessions.values()) session.close('Bot is restarting.');
  setTimeout(() => { client.destroy(); process.exit(0); }, 1500).unref();
});
try { await client.login(config.token); }
catch {
  console.error('Discord login failed. Check DISCORD_TOKEN. If using ! commands, enable Message Content Intent in the developer portal, or set ENABLE_MESSAGE_COMMANDS=false.');
  client.destroy(); process.exitCode = 1;
}

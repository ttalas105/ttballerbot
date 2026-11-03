import { ApplicationIntegrationType, InteractionContextType, SlashCommandBuilder } from 'discord.js';

const command = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description)
  .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

export const commands = [
  command('play', 'Join your voice channel and queue a song or Spotify playlist/album')
    .addStringOption(option => option.setName('query').setDescription('Song name, Spotify link, or YouTube link').setRequired(true).setMaxLength(500)),
  command('queue', 'View upcoming songs').addIntegerOption(option => option.setName('page').setDescription('Queue page').setMinValue(1)),
  command('nowplaying', 'Show the current player card'),
  command('pause', 'Pause the music'), command('resume', 'Resume the music'),
  command('skip', 'Play the next song'), command('back', 'Play the previous song, or restart the first song'),
  command('shuffle', 'Shuffle upcoming songs'), command('clear', 'Clear upcoming songs'),
  command('remove', 'Remove a song from the upcoming queue')
    .addIntegerOption(option => option.setName('position').setDescription('Position shown in /queue').setMinValue(1).setRequired(true)),
  command('stop', 'Stop playback, clear the queue, and leave voice'),
  command('hey', 'Opt your own voice into the Hey Baller assistant, or stop listening')
    .addStringOption(option => option.setName('mode').setDescription('Only on opts your own voice in for 15 minutes').setRequired(true)
      .addChoices({ name: 'On — listen to my voice', value: 'on' }, { name: 'Off — stop listening to me', value: 'off' },
        { name: 'Status', value: 'status' }, { name: 'Stop assistant response', value: 'stop' }, { name: 'Turn listening off for everyone', value: 'alloff' })),
  command('ask', 'Talk to Baller, request music, or trigger an effect in your voice channel')
    .addStringOption(option => option.setName('prompt').setDescription('Tell me a joke, play some J Cole, announce Tyrone like a wedding...').setRequired(true).setMaxLength(500)),
  command('effect', 'Play a sound effect or AI entrance without enabling voice listening')
    .addStringOption(option => option.setName('prompt').setDescription('dramatic soundtrack, air horn, announce <name> like a wedding or wrestling entrance').setRequired(true).setMaxLength(300)),
  command('help', 'How to use ttballerbot'),
];

export const help = [
  '**ttballerbot — your listening room**',
  'Join voice, then use `/play query:<song or link>` or `@ttballerbot play <song or link>`.',
  'If the host enables prefix commands, `!play <song or link>` works too.',
  'Spotify songs, albums, and playlists are looked up; the audio comes from a YouTube match.',
  'Playlist access depends on the connected Spotify account (owner/collaborator for new apps).',
  '',
  '`/queue [page]` · `/nowplaying` · `/pause` · `/resume` · `/skip` · `/back`',
  '`/shuffle` · `/remove position:<number>` · `/clear` · `/stop`',
  'Use the buttons on the player card. Only people in my voice channel can control playback.',
  'Queues are temporary and reset when the bot restarts. I leave automatically when idle or alone.',
  '',
  'Experimental Hey Baller (when enabled by the host): `/hey mode:on` opts in your own voice for 15 minutes.',
  'Say “Hey Baller”, wait for the chime, then ask a question, “tell me a joke”, “play some J Cole”, “pause the music”, or “dramatic soundtrack”.',
  'Try “announce Tyrone like a wedding” or “announce me like a wrestling entrance”. Replies use an AI voice.',
  'Wake again for each request. Your last 4 turns provide per-person context for 10 minutes; opt-out clears it.',
  '`/hey mode:off` opts you out. `/hey mode:alloff` stops all listening. `/hey mode:stop` cancels a response.',
  '`/ask prompt:<request>` works without voice listening. `/effect prompt:air horn` is a shortcut for effects.',
].join('\n');

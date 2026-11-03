import { REST, Routes, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { config, requireDiscordConfig } from '../src/config.js';
import { commands } from '../src/commands.js';

requireDiscordConfig();
const rest = new REST({ version: '10' }).setToken(config.token);
const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
// Only this bot's command list is changed. Other applications are untouched.
await rest.put(route, { body: commands.map(command => command.toJSON()) });
console.log(`Registered ${commands.length} commands ${config.guildId ? 'in the configured server' : 'globally (Discord may take time to propagate them)'}.`);
const permissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
]);
const invite = new URL('https://discord.com/oauth2/authorize');
invite.search = new URLSearchParams({ client_id: config.clientId, scope: 'bot applications.commands', permissions: permissions.bitfield.toString(), ...(config.guildId ? { guild_id: config.guildId } : {}) }).toString();
console.log(`Invite ttballerbot: ${invite.href}`);

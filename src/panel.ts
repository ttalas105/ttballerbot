import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, LabelBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, ModalBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import type { MusicQueue } from './queue.js';

export const clean = (text: string, length = 100): string => escapeMarkdown(text.replace(/@/g, '@\u200b').slice(0, length)).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
export function duration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export interface PanelState {
  id: string; queue: MusicQueue; status: 'loading' | 'playing' | 'paused' | 'idle' | 'stopped';
  elapsed: number; voiceId?: string; notice?: string;
  artworkUrl?: string;
}

const text = (content: string) => new TextDisplayBuilder().setContent(content);
const separator = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true);
const payload = (card: ContainerBuilder) => ({ flags: MessageFlags.IsComponentsV2 as const, components: [card], allowedMentions: { parse: [] as [] } });

export function progressBar(elapsed: number, total: number): string {
  const position = Math.max(0, Math.min(20, Math.round((total > 0 ? elapsed / total : 0) * 20)));
  return `${'━'.repeat(position)}●${'─'.repeat(20 - position)}`;
}

export function buildPanel(state: PanelState) {
  const { queue, status } = state;
  const current = queue.current;
  const stopped = status === 'stopped';
  const paused = status === 'paused';
  const card = new ContainerBuilder().setAccentColor(stopped ? 0x5b6b64 : paused ? 0xe6bc65 : 0x88e8b5);
  if (current) {
    if (state.artworkUrl) card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder()
      .setURL(state.artworkUrl).setDescription(`${current.title} — ${current.artist} | ttballerbot` .slice(0, 1024))));
    const label = status === 'loading' ? (state.elapsed ? 'RECONNECTING' : 'LOADING') : paused ? 'PAUSED' : 'NOW PLAYING';
    const total = current.playbackDurationSeconds || current.durationSeconds;
    card.addTextDisplayComponents(text(`**${label}**  ·  <@${current.requestedBy}>\n**[${clean(current.title, 90)}](${current.url})** · ${clean(current.artist, 90)}`));
    card.addTextDisplayComponents(text(`\`${duration(state.elapsed)}  ${progressBar(state.elapsed, total)}  ${duration(total)}\``));
  } else {
    card.addTextDisplayComponents(text(stopped ? '## Session ended\nSame crew, next session. Use `/play` when you’re ready.' : '## The room is yours\nAdd a song or drop a playlist. Everyone in voice shares the controls.'));
  }
  const remaining = queue.upcoming.length;
  const button = (action: string, label: string, emoji: string, disabled: boolean, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`ttb:${state.id}:${action}`).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('back', 'Back', '⏮️', stopped || (!current && !queue.history.length)),
    button('toggle', paused ? 'Resume' : 'Pause', paused ? '▶️' : '⏸️', stopped || !current || status === 'loading', ButtonStyle.Success),
    button('next', 'Next', '⏭️', stopped || (!current && !remaining)),
    button('shuffle', 'Shuffle', '🔀', stopped || remaining < 2),
    button('stop', 'Stop', '⏹️', stopped, ButtonStyle.Danger),
  );
  card.addActionRowComponents(controls);
  if (state.notice) card.addTextDisplayComponents(text(`-# ${clean(state.notice, 300)}`));
  if (!stopped) {
    card.addSeparatorComponents(separator());
    const queuedSeconds = queue.upcoming.reduce((total, track) => total + track.durationSeconds, 0);
    card.addTextDisplayComponents(text(`### Up next\n-# ${remaining} ${remaining === 1 ? 'track' : 'tracks'} · ${queueDuration(queuedSeconds)} queued`));
    const rows = queue.upcoming.slice(0, 3).map((track, index) => `\`${String(index + 1).padStart(2, '0')}\`  **[${clean(track.title, 60)}](${track.url})**\n-# ${clean(track.artist, 60)} · ${duration(track.durationSeconds)}`);
    card.addTextDisplayComponents(text(rows.length ? rows.join('\n\n') : 'Your next favorite goes here. **Add a song** to keep it going.'));
    card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ttb:${state.id}:add`).setLabel('Add a song').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ttb:${state.id}:queue`).setLabel(remaining > 3 ? `View all ${remaining} tracks` : 'View queue').setStyle(ButtonStyle.Secondary),
    ));
    card.addSeparatorComponents(separator());
    const source = current?.playbackUrl ? `Audio: [${clean(current.playbackTitle || 'YouTube', 70)}](${current.playbackUrl})` : 'Finding your audio…';
    card.addTextDisplayComponents(text(`-# ${state.voiceId ? `<#${state.voiceId}> · ` : ''}${current?.source === 'spotify' ? '[Spotify](' + current.url + ') → ' : ''}${current ? source : '/play to start'}\n-# ttballerbot · Shared controls for everyone in voice`));
  }
  return payload(card);
}

function queueDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function queuePage(queue: MusicQueue, page: number, sessionId?: string) {
  const pages = Math.max(1, Math.ceil(queue.upcoming.length / 10));
  const selected = Math.max(1, Math.min(page, pages));
  const offset = (selected - 1) * 10;
  const card = new ContainerBuilder().setAccentColor(0x88e8b5).addTextDisplayComponents(text(`## Your queue\n${queue.upcoming.length} tracks · ${queueDuration(queue.upcoming.reduce((total, song) => total + song.durationSeconds, 0))} of music`));
  card.addSeparatorComponents(separator()).addTextDisplayComponents(text(queue.upcoming.slice(offset, offset + 10).map((track, i) =>
    `\`${String(offset + i + 1).padStart(2, '0')}\` **[${clean(track.title, 55)}](${track.url})**\n-# ${clean(track.artist, 50)} · ${duration(track.durationSeconds)}`,
  ).join('\n\n') || 'Nothing waiting. Add a song from the player.'));
  if (sessionId) card.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ttq:${sessionId}:${selected - 1}`).setLabel('Previous page').setStyle(ButtonStyle.Secondary).setDisabled(selected <= 1),
    new ButtonBuilder().setCustomId(`ttq:${sessionId}:${selected + 1}`).setLabel('Next page').setStyle(ButtonStyle.Secondary).setDisabled(selected >= pages),
  ));
  card.addTextDisplayComponents(text(`-# Page ${selected} of ${pages} · /remove position:<number>`));
  return payload(card);
}

export function addSongModal(sessionId: string): ModalBuilder {
  return new ModalBuilder().setCustomId(`ttadd:${sessionId}`).setTitle('Add to the room').addLabelComponents(
    new LabelBuilder().setLabel('Song name or link').setDescription('Spotify song, playlist, album, or a YouTube link').setTextInputComponent(
      new TextInputBuilder().setCustomId('query').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500).setPlaceholder('What are we playing next?'),
    ),
  );
}

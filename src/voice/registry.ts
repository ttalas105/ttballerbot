import type { GuildMember } from 'discord.js';
import type { MusicSession } from '../session.js';

/** Look up the current assistant inside the room's lock, never before waiting. */
export function prepareAssistant<T extends { ended: boolean }>(registry: Map<string, T>, guildId: string,
  session: Pick<MusicSession, 'serial' | 'assertMember' | 'connect'>, member: GuildMember,
  create: () => T, prepare?: (assistant: T) => Promise<void>): Promise<T> {
  return session.serial.run(async () => {
    session.assertMember(member);
    await session.connect(member);
    let assistant = registry.get(guildId);
    if (!assistant || assistant.ended) { assistant = create(); registry.set(guildId, assistant); }
    await prepare?.(assistant);
    return assistant;
  });
}

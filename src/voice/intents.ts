import { UserError } from '../model.js';

export type VoiceIntent = { kind: 'stop' | 'dramatic' | 'airhorn' } | { kind: 'entrance'; name: string };
export interface Person { id: string; name: string; aliases: string[] }
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** A narrow command vocabulary keeps incidental speech from becoming arbitrary bot actions. */
export function parseVoiceIntent(text: string, people: Person[]): VoiceIntent {
  const command = normalize(text).replace(/^hey baller\s*/, '');
  if (/^(?:stop|stop (?:the )?(?:effects|sound|soundtrack)|cancel|quiet|silence)$/.test(command)) return { kind: 'stop' };
  if (/^(?:(?:play|give us|give this conversation|put on|add|start) (?:a |some |the )?)?(?:dramatic|suspense|dramatic soundtrack|dramatic music|suspense music|dramatic background music)$/.test(command)) return { kind: 'dramatic' };
  if (/^(?:(?:play|give us|hit) (?:an? |the )?)?air ?horn$/.test(command)) return { kind: 'airhorn' };
  const target = /^(?:announce|introduce) (.+?)(?: like (?:a |an )?(?:wwe|wrestling)(?: entrance| announcer)?| with (?:a |an )?(?:wwe|wrestling) entrance)?$/.exec(command)?.[1]
    || /^give (.+?) (?:a |an )?(?:wwe |wrestling )?entrance$/.exec(command)?.[1];
  if (target) {
    const matches = people.filter(person => [person.name, ...person.aliases].some(alias => normalize(alias) === target));
    if (matches.length === 1) return { kind: 'entrance', name: matches[0]!.name.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 50) || 'the legend' };
    if (matches.length > 1) throw new UserError('That name matches more than one person. Use their full Discord display name.');
    throw new UserError('I couldn’t match that name to someone in voice. Try their Discord display name.');
  }
  throw new UserError('Try “dramatic soundtrack”, “air horn”, “announce <Discord name> like a wrestling entrance”, or “stop”.');
}

export function entranceLine(name: string): string {
  return `Ladies and gentlemen! Entering the call! The undisputed champion of showing up late and talking trash! Make some noise for... ${name}!`;
}

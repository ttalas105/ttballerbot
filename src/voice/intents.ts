import { VoiceError } from '../model.js';
import { parseInput } from '../input.js';

export const actionKinds = ['say', 'music', 'pause', 'resume', 'skip', 'back', 'shuffle', 'stop_music', 'stop', 'dramatic', 'airhorn', 'entrance', 'wedding'] as const;
type SimpleKind = Exclude<typeof actionKinds[number], 'say' | 'music' | 'entrance' | 'wedding'>;
export type VoiceIntent = { kind: SimpleKind } | { kind: 'music'; query: string }
  | { kind: 'entrance' | 'wedding'; name: string } | { kind: 'chat'; text: string } | { kind: 'say'; reply: string };
export interface Person { id: string; name: string; aliases: string[] }
export interface VoiceDecision { transcript: string; intent: Exclude<VoiceIntent, { kind: 'chat' }> }
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

export function resolveName(target: string, people: Person[], userId?: string): string {
  const name = normalize(target);
  const matches = /^(?:me|myself)$/.test(name) ? people.filter(person => person.id === userId)
    : people.filter(person => [person.name, ...person.aliases].some(alias => normalize(alias) === name));
  if (matches.length > 1) throw new VoiceError('That name matches more than one person. Use their full Discord display name.', 'VOICE_AMBIGUOUS_NAME');
  const clean = (matches[0]?.name || target).replace(/[^\p{L}\p{N} .'-]/gu, '').trim();
  if (!clean || clean.length > 50) throw new VoiceError('Give me a short name to announce.', 'VOICE_INVALID_NAME');
  return clean.replace(/^\p{L}/u, letter => letter.toUpperCase());
}

const requestText = (text: string) => text.trim().replace(/^hey rajan[,!\s]*/i, '').replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '').replace(/[,!?.]*\s+please[.!?]*$/i, '').trim();

/** Exact controls only; never interpret free-form arguments or quoted instructions. */
export function parseImmediateVoiceIntent(text: string): { kind: SimpleKind } | undefined {
  if (/["'“”‘’]/.test(text)) return undefined;
  const command = normalize(requestText(text));
  if (/^(?:stop|stop (?:the )?(?:effects|sound|soundtrack|talking)|cancel|quiet|silence)$/.test(command)) return { kind: 'stop' };
  if (/^(?:stop (?:the )?music|stop playing music)$/.test(command)) return { kind: 'stop_music' };
  if (/^(?:pause|pause (?:the )?(?:music|song))$/.test(command)) return { kind: 'pause' };
  if (/^(?:resume|resume (?:the )?music|unpause|keep playing)$/.test(command)) return { kind: 'resume' };
  if (/^(?:skip|next|next song|skip (?:this|the) (?:song|track))$/.test(command)) return { kind: 'skip' };
  if (/^(?:back|go back|previous song)$/.test(command)) return { kind: 'back' };
  if (/^(?:shuffle|shuffle (?:the )?(?:queue|music))$/.test(command)) return { kind: 'shuffle' };
  if (/^(?:(?:play|give us|give this conversation|put on|add|start) (?:a |some |the )?)?(?:dramatic|suspense|dramatic soundtrack|dramatic music|suspense music|dramatic background music)$/.test(command)) return { kind: 'dramatic' };
  if (/^(?:(?:play|give us|hit) (?:an? |the )?)?air ?horn$/.test(command)) return { kind: 'airhorn' };
}

/** Fast path for explicit typed requests; other requests go to the conversational model. */
export function parseVoiceIntent(text: string, people: Person[], userId?: string): VoiceIntent {
  const raw = requestText(text);
  const command = normalize(raw).replace(/\bw w e\b/g, 'wwe');
  if (!command) throw new VoiceError('I didn’t hear a request. Say “Hey Rajan”, then speak after the chime.', 'VOICE_EMPTY_COMMAND');
  const immediate = parseImmediateVoiceIntent(text);
  if (immediate) return immediate;
  const wedding = /^(?:announce|introduce) (.+?) (?:like|at|for|as if (?:at|its)) (?:a |an |their )?wedding(?: entrance| announcer)?$/.exec(command)?.[1];
  if (wedding) return { kind: 'wedding', name: resolveName(wedding, people, userId) };
  const target = /^(?:announce|introduce) (.+?)(?: like (?:a |an )?(?:wwe|wrestling)(?: entrance| announcer)?| with (?:a |an )?(?:wwe|wrestling) entrance)$/.exec(command)?.[1]
    || /^give (.+?) (?:a |an )?(?:wwe |wrestling )?entrance$/.exec(command)?.[1]
    || /^(?:announce|introduce) ([\p{L}\p{N}]+)$/u.exec(command)?.[1];
  if (target) return { kind: 'entrance', name: resolveName(target, people, userId) };
  const query = /^(?:play|put on|queue|add)(?:\s+some)?\s+(.+)$/i.exec(raw)?.[1]?.trim();
  if (query) { parseInput(query); return { kind: 'music', query }; }
  return { kind: 'chat', text: text.slice(0, 500) };
}

/** Validate every model response before it can reach a music or voice operation. */
export function parseDecision(raw: string, people: Person[], userId?: string): VoiceDecision {
  const invalid = () => new VoiceError('I couldn’t understand that response. Please try a shorter request.', 'VOICE_INVALID_RESPONSE');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (typeof item.transcript !== 'string' || item.transcript.length > 500 || typeof item.kind !== 'string'
    || !actionKinds.includes(item.kind as typeof actionKinds[number])) throw invalid();
  const transcript = item.transcript.trim();
  if (!transcript) throw new VoiceError('I didn’t catch that. Say “Hey Rajan” and try again after the chime.', 'VOICE_EMPTY_COMMAND');
  let intent: VoiceDecision['intent'];
  if (item.kind === 'music') {
    if (typeof item.query !== 'string' || !item.query.trim() || item.query.length > 500) throw invalid();
    parseInput(item.query); intent = { kind: 'music', query: item.query.trim() };
  } else if (item.kind === 'entrance' || item.kind === 'wedding') {
    if (typeof item.name !== 'string') throw invalid();
    intent = { kind: item.kind, name: resolveName(item.name, people, userId) };
  } else if (item.kind === 'say') {
    if (typeof item.reply !== 'string' || !item.reply.trim() || item.reply.length > 500) throw invalid();
    intent = { kind: 'say', reply: item.reply.trim() };
  } else intent = { kind: item.kind as SimpleKind };
  return { transcript, intent };
}

export function entranceLine(name: string): string {
  return `Entering the call: the undefeated champion of showing up late. Make some noise for... ${name}!`;
}

export function weddingLine(name: string): string {
  return `Everybody on your feet! A little love and a loud welcome for... ${name}! Let the celebration begin!`;
}

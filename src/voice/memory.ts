export interface ConversationTurn { request: string; response: string }

/** Per-speaker, per-session context. Never persisted or shared with another speaker. */
export class VoiceMemory {
  private readonly users = new Map<string, { expires: number; turns: ConversationTurn[]; timer: NodeJS.Timeout }>();
  constructor(private readonly now = Date.now, private readonly ttl = 10 * 60000) {}
  get(userId: string): ConversationTurn[] {
    for (const [id, value] of this.users) if (value.expires <= this.now()) this.remove(id);
    return (this.users.get(userId)?.turns || []).map(turn => ({ ...turn }));
  }
  add(userId: string, request: string, response: string): void {
    const turns = [...this.get(userId), { request: request.slice(0, 500), response: response.slice(0, 500) }].slice(-4);
    if (!this.users.has(userId) && this.users.size >= 4) this.remove(this.users.keys().next().value!);
    this.remove(userId);
    const timer = setTimeout(() => this.remove(userId), this.ttl); timer.unref();
    this.users.set(userId, { expires: this.now() + this.ttl, turns, timer });
  }
  remove(userId: string): void { clearTimeout(this.users.get(userId)?.timer); this.users.delete(userId); }
  clear(): void { for (const id of this.users.keys()) this.remove(id); }
}

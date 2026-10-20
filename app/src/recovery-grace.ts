/** Keep the last image during short reconnects without delaying stream recovery. */
export class RecoveryGrace {
  private pending = new Map<string, { timer: NodeJS.Timeout; expire: () => void }>();

  constructor(private readonly durationMs = 30_000) {}

  defer(id: string, lastProgressAt: number | undefined, expire: () => void): void {
    const current = this.pending.get(id);
    if (current) {
      current.expire = expire;
      return;
    }
    const age = lastProgressAt ? Math.max(0, Date.now() - lastProgressAt) : 0;
    const pending = {
      expire,
      timer: setTimeout(
        () => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          pending.expire();
        },
        Math.max(0, this.durationMs - age),
      ),
    };
    pending.timer.unref();
    this.pending.set(id, pending);
  }

  cancel(id: string): void {
    const pending = this.pending.get(id);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(id);
  }

  clear(): void {
    for (const id of this.pending.keys()) this.cancel(id);
  }
}

/** One cancellable recovery loop per camera; failures never change the user's ON/OFF choice. */
export interface StreamRecoveryOptions {
  isEnabled: () => Promise<boolean>;
  recover: (signal: AbortSignal, attempt: number, reason: string) => Promise<void>;
  onError?: (error: unknown, attempt: number) => void;
  baseMs?: number;
  maxMs?: number;
  videoTimeoutMs?: number;
  dispatchTimeoutMs?: number;
  stableMs?: number;
  random?: () => number;
}

export class StreamRecovery {
  private attempt = 0;
  private nextAttempt = 0;
  private generation = 0;
  private healthyRevision = 0;
  private timer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private active?: AbortController;
  private stopped = false;

  constructor(private readonly options: StreamRecoveryOptions) {}

  public request(reason: string): void {
    if (this.stopped || this.active) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.run(reason),
      Math.max(0, this.nextAttempt - Date.now()),
    );
    this.timer.unref();
  }

  private async run(reason: string): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.active) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.active = controller;
    const healthyRevision = this.healthyRevision;
    const timeout = setTimeout(
      () => controller.abort(new Error("Stream recovery timed out")),
      this.options.dispatchTimeoutMs ?? 30_000,
    );
    timeout.unref();
    let dispatched = false;
    let enabled = true;
    try {
      enabled = await this.options.isEnabled();
      if (!enabled || this.stopped || generation !== this.generation) return;
      controller.signal.throwIfAborted();
      this.attempt++;
      const cap = Math.min(
        this.options.maxMs ?? 60_000,
        (this.options.baseMs ?? 15_000) * 1.4 ** Math.min(this.attempt - 1, 5),
      );
      this.nextAttempt =
        Date.now() + cap * (0.75 + (this.options.random?.() ?? Math.random()) * 0.25);
      await this.options.recover(controller.signal, this.attempt, reason);
      controller.signal.throwIfAborted();
      dispatched = true;
    } catch (error) {
      if (generation === this.generation && !this.stopped)
        this.options.onError?.(error, this.attempt);
    } finally {
      clearTimeout(timeout);
      if (this.active === controller) this.active = undefined;
      if (
        enabled &&
        generation === this.generation &&
        !this.stopped &&
        healthyRevision === this.healthyRevision
      ) {
        // Always retain a retry, including a watchdog request inside the cooldown.
        const delay = dispatched
          ? (this.options.videoTimeoutMs ?? 35_000)
          : (this.options.baseMs ?? 15_000);
        this.timer = setTimeout(
          () => this.request("Still waiting for live video"),
          Math.max(delay, this.nextAttempt - Date.now()),
        );
        this.timer.unref();
      }
    }
  }

  public healthy(): void {
    this.healthyRevision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stableTimer) {
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
        this.nextAttempt = 0;
        this.stableTimer = undefined;
      }, this.options.stableMs ?? 60_000);
      this.stableTimer.unref();
    }
  }

  public stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.stableTimer);
    this.active?.abort(new Error("Stream recovery cancelled"));
  }
}

import { createHash, randomUUID } from "node:crypto";
import { promises as fs, mkdirSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { format } from "node:util";

const sensitiveKey =
  /^(?:authorization|cookie|password|passwd|pass|token|access_token|refresh_token|secret|.*_pass|.*_token|.*_secret|.*_key(?:_hex)?|app_sign|app_pub_hex|dev_pub_hex|init_string|data_base64)$/i;

export function redactDiagnostic(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- Remove terminal control characters from logs.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/\b(?:https?|rtsps?|rtmp|mqtts?):\/\/[^\s<>"']+/gi, "[private URL]")
      .replace(/\bBearer\s+[^\s,"']+/gi, "Bearer [redacted]")
      .replace(
        /(["']?(?:(?:[\w-]*[_-])?(?:password|passwd|pass|token|secret)|cookie|authorization|app_sign|\w*_key(?:_hex)?|init_string)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
        "$1[redacted]",
      )
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[private address]")
      .replace(/\[?[a-f\d:]*:[a-f\d:.]+\]?(?:%[\w-]+)?/gi, (candidate) =>
        isIP(candidate.replace(/^\[|\]$/g, "")) === 6 ? "[private address]" : candidate,
      )
      .replace(/\b[a-f\d]{32,}\b/gi, "[redacted hex]")
      .slice(0, 2048)
  );
}

export function cameraDiagnosticId(did: string): string {
  return createHash("sha256").update(did).digest("hex").slice(0, 12);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth limit]";
  if (typeof value === "string") return redactDiagnostic(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === "boolean") return value;
  if (value instanceof Error)
    return {
      name: value.name,
      message: redactDiagnostic(value.message),
      stack: redactDiagnostic(value.stack ?? ""),
    };
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [
          key.slice(0, 80),
          sensitiveKey.test(key) ? "[redacted]" : sanitize(item, depth + 1),
        ]),
    );
  }
  return String(value);
}

/** Best-effort bounded journal. Disk failures never interrupt camera work. */
export class DiagnosticJournal {
  readonly boot = randomUUID();
  private sequence = 0;
  private queue: string[] = [];
  private dropped = 0;
  private writer?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private bytes?: number;
  private warnedAt = 0;
  private readonly warning = console.warn.bind(console);

  constructor(
    private readonly directory: string,
    private readonly maxBytes = 1024 * 1024,
    private readonly copies = 4,
  ) {}

  crash(error: unknown, origin: string): void {
    // The exception monitor runs immediately before Node exits; async writes
    // cannot preserve this final event. A separate bounded file avoids racing
    // the ordinary rotating writer and retains the last crash across restarts.
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.directory, "crash.json.tmp");
      writeFileSync(
        temporary,
        JSON.stringify({
          time: new Date().toISOString(),
          boot: this.boot,
          event: "app.crash",
          origin,
          error: sanitize(error),
        }),
        { mode: 0o600, flush: true },
      );
      chmodSync(temporary, 0o600);
      renameSync(temporary, path.join(this.directory, "crash.json"));
    } catch {
      /* Logging cannot replace the original fatal error. */
    }
  }

  record(event: string, fields: Record<string, unknown> = {}, level = "info"): void {
    try {
      if (this.queue.length >= 256) {
        this.dropped++;
        return;
      }
      const details = JSON.stringify(sanitize(fields));
      const line =
        JSON.stringify({
          time: new Date().toISOString(),
          boot: this.boot,
          seq: ++this.sequence,
          level,
          event: redactDiagnostic(event),
          fields:
            details.length > 8192
              ? { message: details.slice(0, 4000), truncated: true }
              : JSON.parse(details),
        }) + "\n";
      this.queue.push(line);
      if (!this.timer && !this.writer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, 25);
        this.timer.unref();
      }
    } catch {
      this.dropped++;
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writer) return this.writer;
    this.writer = this.drain()
      .catch(() => {
        this.bytes = undefined;
        this.dropped += this.queue.length;
        this.queue.length = 0;
        if (Date.now() - this.warnedAt > 60_000) {
          this.warnedAt = Date.now();
          this.warning("[Diagnostics] Journal unavailable; camera processing continues");
        }
      })
      .finally(() => {
        this.writer = undefined;
      });
    return this.writer;
  }

  private async drain(): Promise<void> {
    if (!this.queue.length) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const file = path.join(this.directory, "events.jsonl");
    if (this.bytes === undefined)
      this.bytes = (await fs.stat(file).catch(() => ({ size: 0 }))).size;
    while (this.queue.length) {
      const batch = this.queue.splice(0, 32);
      if (this.dropped && this.queue.length === 0) {
        batch.push(
          JSON.stringify({
            time: new Date().toISOString(),
            boot: this.boot,
            event: "diagnostics.dropped",
            count: this.dropped,
          }) + "\n",
        );
        this.dropped = 0;
      }
      const payload = batch.join("");
      const size = Buffer.byteLength(payload);
      if (this.bytes + size > this.maxBytes && this.bytes > 0) {
        for (let i = this.copies - 1; i >= 1; i--) {
          const from = i === 1 ? file : `${file}.${i - 1}`;
          try {
            await fs.rename(from, `${file}.${i}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        this.bytes = 0;
      }
      // Per-record limit and a bounded batch also bound a temporary rotation overshoot.
      const handle = await fs.open(file, "a", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(payload);
        await handle.datasync();
        this.bytes += size;
      } finally {
        await handle.close();
      }
    }
  }

  captureConsole(): () => void {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    methods.forEach((method, i) => {
      console[method] = (...args: unknown[]) => {
        const message = redactDiagnostic(format(...args));
        this.record("console", { message }, method);
        originals[i].call(console, message);
      };
    });
    return () =>
      methods.forEach((method, i) => {
        console[method] = originals[i];
      });
  }
}

let active: DiagnosticJournal | undefined;
export const diagnostics = {
  start(directory: string): DiagnosticJournal {
    return (active ??= new DiagnosticJournal(directory));
  },
  record(event: string, fields: Record<string, unknown> = {}, level = "info"): void {
    active?.record(event, fields, level);
  },
  async flush(): Promise<void> {
    await active?.flush();
  },
};

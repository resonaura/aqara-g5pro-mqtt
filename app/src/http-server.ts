/**
 * FrameHttpServer — tiny built-in HTTP server that serves cached JPEG snapshots.
 *
 * Serves `GET /frame/<slug>` → reads `data/frames/<slug>.jpg` and returns it
 * with `Content-Type: image/jpeg`. Returns 404 if the frame is missing.
 *
 * Additional endpoints:
 *   GET /health              → 200 OK, plain text "ok"
 *   GET /frames/list         → JSON array of available frame slugs
 *
 * Bound to `process.env.HTTP_PORT || 8080`.  The server is a singleton —
 * call `start()` once; call `stop()` on application shutdown.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  fstatSync,
  closeSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { findFreePort } from "./ports.js";

export class FrameHTTPServer {
  private server: http.Server | null = null;
  private port: number;
  private readonly framesDir: string;
  private readonly hausCameras = new Map<
    string,
    { stream: { protocol: string; port: number; path: string }; snapshotPath: string }
  >();

  public registerHausCamera(slug: string, rtspUrl: string): void {
    const source = new URL(rtspUrl);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(slug)) return;
    this.hausCameras.set(slug, {
      stream: {
        protocol: source.protocol,
        port: Number(source.port || 554),
        path: source.pathname,
      },
      snapshotPath: `/api/cameras/${slug}/snapshot/last-live`,
    });
  }

  constructor(framesDir: string, port?: number) {
    this.framesDir = framesDir;
    this.port = port ?? Number(process.env.HTTP_PORT || 8580);
  }

  public get listenPort(): number {
    return this.port;
  }

  public async start(): Promise<number> {
    if (this.server) return this.port;

    this.port = await findFreePort(this.port);

    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        const url = req.url ?? "/";

        // ── /health ─────────────────────────────────────────────────────────────
        if (url === "/health" || url === "/health/") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
          return;
        }

        // ── /frames/list ────────────────────────────────────────────────────────
        if (url === "/frames/list" || url === "/frames/list/") {
          try {
            const files = readdirSync(this.framesDir).filter(
              (f) => f.endsWith(".jpg") && statSync(path.join(this.framesDir, f)).size > 0,
            );
            const slugs = files.map((f) => f.replace(/\.jpg$/, ""));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(slugs));
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("[]");
          }
          return;
        }

        if (url === "/api/haus/cameras") {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(
            JSON.stringify({
              version: 1,
              provider: "aqara",
              cameras: [...this.hausCameras.values()],
            }),
          );
          return;
        }
        // Real-only cache: generated Offline cards never reach this endpoint.
        const lastLive = url.match(/^\/api\/cameras\/([a-zA-Z0-9_-]{1,128})\/snapshot\/last-live$/);
        if (lastLive) {
          try {
            const file = path.join(this.framesDir, lastLive[1] + ".last_live.jpg");
            const descriptor = openSync(file, "r");
            let data: Buffer;
            let at: number;
            try {
              at = fstatSync(descriptor).mtimeMs;
              data = readFileSync(descriptor);
            } finally {
              closeSync(descriptor);
            }
            if (data.length < 4 || data[0] !== 255 || data[1] !== 216) throw Error("missing_frame");
            res.writeHead(200, {
              "Content-Type": "image/jpeg",
              "Cache-Control": "no-store",
              "Content-Length": data.length,
              "X-Haus-Snapshot-Profile": "1",
              "X-Haus-Snapshot-Provider": "aqara",
              "X-Haus-Snapshot-Captured-At": String(at),
              "X-Haus-Snapshot-Stale": Date.now() - at >= 30000 ? "1" : "0",
            });
            res.end(data);
          } catch {
            res.writeHead(404);
            res.end();
          }
          return;
        }

        // ── /frame/<slug>, /snapshot/<slug>, /api/cameras/<slug>/snapshot ───────
        const match =
          url.match(/^\/frame\/([^/]+)$/) ||
          url.match(/^\/snapshot\/([^/]+)$/) ||
          url.match(/^\/api\/cameras\/([^/]+)\/snapshot$/);
        if (match) {
          const slug = match[1];
          const currentPath = path.join(this.framesDir, `${slug}.jpg`);
          const filePath = existsSync(currentPath)
            ? currentPath
            : path.join(this.framesDir, `${slug}.last_live.jpg`);
          if (!existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
            return;
          }
          try {
            const data = readFileSync(filePath);
            res.writeHead(200, {
              "Content-Type": "image/jpeg",
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "Content-Length": data.length,
            });
            res.end(data);
          } catch {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal error");
          }
          return;
        }

        // Unknown route
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      });

      srv.on("error", (err: NodeJS.ErrnoException) => {
        console.error(`❌ [HTTP] Server error: ${err.message}`);
      });

      srv.listen(this.port, "0.0.0.0", () => {
        this.server = srv;
        console.log(`🌐 [HTTP] Frame server listening on port ${this.port}`);
        resolve(this.port);
      });
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close(() => {
        this.server = null;
      });
    }
  }
}

export const FrameHttpServer = FrameHTTPServer;

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

export interface NativeBridgeOptions {
  did: string;
  deviceName: string;
  cameraIp: string;
  cameraPort?: number;
  videoKeyHex: string;
  rtspPort: number;
  isHevc?: boolean;
}

export interface NativeMetrics {
  type: string;
  did: string;
  fps: number;
  kbps: number;
  frames: number;
  clients: number;
  live: boolean;
}

export class AqaraNativeBridge extends EventEmitter {
  private options: NativeBridgeOptions;
  private process: ChildProcess | null = null;
  private isRunning: boolean = false;
  private binaryPath: string;

  constructor(options: NativeBridgeOptions) {
    super();
    this.options = options;
    this.binaryPath = path.resolve(process.cwd(), 'native/build/aqara-media-core');
  }

  public async start(): Promise<boolean> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`C++ binary not found at ${this.binaryPath}. Please run: cmake --build native/build`);
    }

    const args = [
      '--did', this.options.did,
      '--ip', this.options.cameraIp,
      '--port', String(this.options.cameraPort || 32108),
      '--key', this.options.videoKeyHex,
      '--rtsp-port', String(this.options.rtspPort),
    ];

    if (this.options.isHevc) {
      args.push('--hevc');
    }

    console.log(`🚀 [NativeBridge] Launching aqara-media-core for ${this.options.deviceName} (${this.options.did})...`);
    this.process = spawn(this.binaryPath, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.isRunning = true;

    let stdoutBuf = '';
    this.process.stdout?.on('data', (data: Buffer) => {
      stdoutBuf += data.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.type === 'metrics') {
            this.emit('metrics', json as NativeMetrics);
          } else if (json.type === 'talkback') {
            this.emit('talkback', json);
          }
        } catch {
          // ignore non-json log lines
        }
      }
    });

    this.process.on('exit', (code, signal) => {
      console.log(`⚠️ [NativeBridge] aqara-media-core exited with code ${code} (signal: ${signal})`);
      this.isRunning = false;
      this.process = null;
      this.emit('exit', { code, signal });
    });

    return true;
  }

  public startTalkback(): void {
    if (!this.isRunning || !this.process?.stdin) return;
    this.process.stdin.write(JSON.stringify({ cmd: 'start_talkback' }) + '\n');
  }

  public stopTalkback(): void {
    if (!this.isRunning || !this.process?.stdin) return;
    this.process.stdin.write(JSON.stringify({ cmd: 'stop_talkback' }) + '\n');
  }

  public sendAudioFrame(pcmData: Buffer): void {
    if (!this.isRunning || !this.process?.stdin) return;
    const b64 = pcmData.toString('base64');
    this.process.stdin.write(JSON.stringify({ cmd: 'send_talkback_audio', audio_b64: b64 }) + '\n');
  }

  public stop(): void {
    if (!this.isRunning || !this.process) return;
    try {
      this.process.stdin?.write(JSON.stringify({ cmd: 'stop' }) + '\n');
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
        }
      }, 500);
    } catch {
      this.process.kill('SIGKILL');
    }
  }
}

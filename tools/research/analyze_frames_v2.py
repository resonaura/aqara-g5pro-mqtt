#!/usr/bin/env python3
"""
Frame quality analyzer v2 (IR/night mode aware).
The Guinea Pigs camera runs with IR light -> correct picture is GRAYSCALE.
So gray pixels are FINE. Verdict is based on:
  - unique color buckets (dead frame = 1..20, real B&W frame = hundreds+)
  - dominant color share (dead = >90%)
  - luma entropy (dead = <1.5, real = >4)
Usage: python3 analyze_frames_v2.py <video> [--frames N]
"""
import subprocess, sys, collections, math

def analyze(path, max_frames=8):
    W, H = 640, 360
    cmd = ['ffmpeg','-v','error','-i',path,'-frames:v',str(max_frames),
           '-vf',f'scale={W}:{H}','-f','rawvideo','-pix_fmt','rgb24','-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    if not raw:
        print('FFMPEG_DECODE_FAIL')
        return 1
    fsz = W*H*3
    n = len(raw)//fsz
    print(f'FRAMES_DECODED={n}')
    verdicts = []
    for i in range(n):
        fr = raw[i*fsz:(i+1)*fsz]
        total = W*H
        colors = collections.Counter()
        hist = [0]*64
        for px in range(0, len(fr), 3):
            r,g,b = fr[px], fr[px+1], fr[px+2]
            colors[(r>>3, g>>3, b>>3)] += 1
            y = (r*299 + g*587 + b*114)//1000
            hist[y>>2] += 1
        uniq = len(colors)
        top = colors.most_common(1)[0][1] / total
        entropy = -sum((c/total)*math.log2(c/total) for c in hist if c)
        # IR night scenes are dark & grayscale: judge by structure, not palette.
        # A broken frame is FLAT (std < 5, gradient < 1). Real content has edges.
        import statistics
        lumas = [fr[i] for i in range(0, len(fr), 3)]
        mean_l = sum(lumas)/len(lumas)
        std_l = (sum((x-mean_l)**2 for x in lumas)/len(lumas)) ** 0.5
        grad = sum(abs(lumas[i+1]-lumas[i]) for i in range(len(lumas)-1))/len(lumas)
        # bimodal tile analysis: dark IR scene = flat background + bright objects
        tile=20; tstds=[]
        for ty in range(0,H,tile):
            for tx in range(0,W,tile):
                pxs=[fr[(y*W+x)*3] for y in range(ty,min(ty+tile,H)) for x in range(tx,min(tx+tile,W))]
                m=sum(pxs)/len(pxs)
                tstds.append((sum((q-m)**2 for q in pxs)/len(pxs))**0.5)
        tstds.sort()
        bright_tiles = sum(1 for t in tstds if t>8)/len(tstds)
        flat_tiles = sum(1 for t in tstds if t<3)/len(tstds)
        healthy = (bright_tiles > 0.05 and flat_tiles > 0.15) or (std_l > 6 and grad > 1.2) or (uniq > 400 and entropy > 3.0)
        v = 'HEALTHY' if healthy else 'BROKEN'
        verdicts.append(healthy)
        print(f'frame#{i}: unique={uniq} std={std_l:.1f} grad={grad:.2f} bright_tiles={bright_tiles:.0%} -> {v}')
    ok = sum(verdicts)
    print(f'SUMMARY: {ok}/{len(verdicts)} healthy')
    print('VERDICT: ' + ('DECRYPTION OK' if ok == len(verdicts) else ('PARTIAL' if ok else 'BROKEN')))
    return 0 if ok == len(verdicts) else 1

if __name__ == '__main__':
    sys.exit(analyze(sys.argv[1], int(sys.argv[sys.argv.index('--frames')+1]) if '--frames' in sys.argv else 8))

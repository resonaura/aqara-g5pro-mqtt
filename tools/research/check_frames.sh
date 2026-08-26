#!/bin/bash
# Capture fresh E1 stream + judge decryption quality -> app.log
# Usage: ./check_frames.sh [seconds_to_capture]
set -u
DUR="${1:-25}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
H264=/tmp/e1_live_decrypted.h264
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$ROOT/app.log"; }

log "=== check_frames start ==="
rm -f $H264
cd "$ROOT/app"
timeout_bin=$(command -v timeout || true)
# capture frames via existing test (it stops itself after 50 frames)
npx tsx test_e1_live_decrypt.ts >> "$ROOT/app.log" 2>&1 &
CAP_PID=$!
sleep "$DUR"
kill $CAP_PID 2>/dev/null

if [ ! -s $H264 ]; then
  log "NO FRAMES captured (bridge failed?) — see app.log above"
  exit 2
fi
log "captured h264: $(stat -f%z $H264) bytes"

{
  echo "########## FRAME ANALYSIS $(date +%H:%M:%S) ##########"
  python3 "$ROOT/app/src/scripts/analyze_frames.py" $H264 --frames 10
  echo "########## END FRAME ANALYSIS ##########"
} >> "$ROOT/app.log" 2>&1

grep -A20 "FRAME ANALYSIS" "$ROOT/app.log" | tail -16
log "=== done ==="

j#!/bin/bash
# E1 P2P capture runner.
# Usage:
#   ./run_e1_capture.sh [seconds]   (default 90)
# 1. Starts tcpdump inside the emulator (ALL udp, in+out)
# 2. Waits N seconds — open the Guinea Pigs Camera live view in Aqara Home now!
# 3. Stops tcpdump, pulls the pcap, analyzes it and appends everything to app.log
set -u
DUR="${1:-90}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
TS=$(date +%Y%m%d_%H%M%S)
PCAP_LOCAL="$ROOT/captures/e1_emu_$TS.pcap"
mkdir -p "$ROOT/captures"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$ROOT/app.log"; }

log "=== run_e1_capture start (dur=${DUR}s) ==="

# 1. start tcpdump in emulator (root), all udp traffic both directions
adb shell "su 0 sh -c 'killall tcpdump 2>/dev/null; rm -f /data/local/tmp/e1emu.pcap; nohup /data/local/tmp/tcpdump -i any -s0 -w /data/local/tmp/e1emu.pcap udp >/dev/null 2>&1 &'"
sleep 1
adb shell "su 0 sh -c 'ps -A | grep tcpdump'" | tee -a "$ROOT/app.log"

log ">>> NOW OPEN THE GUINEA PIGS CAMERA LIVE VIEW IN THE APP (${DUR}s window) <<<"
sleep "$DUR"

# 2. stop & pull
adb shell "su 0 sh -c 'killall -INT tcpdump 2>/dev/null; sleep 1; killall tcpdump 2>/dev/null'"
adb pull /data/local/tmp/e1emu.pcap "$PCAP_LOCAL" >> "$ROOT/app.log" 2>&1
log "pcap saved: $PCAP_LOCAL ($(stat -f%z "$PCAP_LOCAL") bytes)"

# 3. analyze -> app.log
{
  echo ""
  echo "########## ANALYSIS $TS ##########"
  python3 "$ROOT/app/src/scripts/analyze_capture.py" "$PCAP_LOCAL" aqaraus19kn
  echo "########## END ANALYSIS ##########"
} >> "$ROOT/app.log" 2>&1

log "analysis appended to app.log"
log "=== done ==="

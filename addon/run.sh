#!/usr/bin/env bash
set -e

CONFIG_PATH=/data/options.json
ENV_FILE="/usr/src/app/.env"

USERNAME=$(jq -r '.username' $CONFIG_PATH)
PASSWORD=$(jq -r '.password' $CONFIG_PATH)
AREA=$(jq -r '.area' $CONFIG_PATH)
MQTT_URL="mqtt://core-mosquitto:1883"
MQTT_USER=$(jq -r '.mqtt_user' $CONFIG_PATH)
MQTT_PASS=$(jq -r '.mqtt_pass' $CONFIG_PATH)
POLL_INTERVAL=$(jq -r '.poll_interval' $CONFIG_PATH)
LOG_LEVEL=$(jq -r '.log_level' $CONFIG_PATH)

function needs_regen() {
  [ ! -f "$ENV_FILE" ] && return 0

  grep -q "TOKEN=" "$ENV_FILE" || return 0
  grep -q "SUBJECT_ID=" "$ENV_FILE" || return 0

  CURRENT_HASH=$(echo "$USERNAME|$PASSWORD|$AREA|$MQTT_USER|$MQTT_PASS|$POLL_INTERVAL|$LOG_LEVEL" | sha256sum | cut -d' ' -f1)
  SAVED_HASH=$(grep '^CONFIG_HASH=' "$ENV_FILE" | cut -d'=' -f2- || echo "")

  [ "$CURRENT_HASH" != "$SAVED_HASH" ]
}

if needs_regen; then
  echo "🔑 Generating new .env (config changed or missing)"
  node dist/scripts/setup.js --auto \
    --username "$USERNAME" \
    --password "$PASSWORD" \
    --area "$AREA" \
    --mqtt-url "$MQTT_URL" \
    --mqtt-user "$MQTT_USER" \
    --mqtt-pass "$MQTT_PASS" \
    --poll-interval "$POLL_INTERVAL" \
    --log-level "$LOG_LEVEL"

  HASH=$(echo "$USERNAME|$PASSWORD|$AREA|$MQTT_USER|$MQTT_PASS|$POLL_INTERVAL|$LOG_LEVEL" | sha256sum | cut -d' ' -f1)
  echo "CONFIG_HASH=$HASH" >> "$ENV_FILE"
else
  echo "✅ Existing .env is valid and matches config, skipping setup"
fi

echo "🚀 Starting Aqara G5 Pro integration..."
node dist/index.js

#!/usr/bin/with-contenv bashio
CONFIG_PATH=/data/options.json
ENV_FILE="/usr/src/app/.env"

if bashio::services.available mqtt ; then
  export SYSTEM_MQTT_HOST="$(bashio::services mqtt 'host')"
  export SYSTEM_MQTT_PORT="$(bashio::services mqtt 'port')"
  export SYSTEM_MQTT_USER="$(bashio::services mqtt 'username')"
  export SYSTEM_MQTT_PASS="$(bashio::services mqtt 'password')"
fi

# Читаем user config
USERNAME=$(jq -r '.username' $CONFIG_PATH)
PASSWORD=$(jq -r '.password' $CONFIG_PATH)
AREA=$(jq -r '.area' $CONFIG_PATH)
USER_MQTT_URL=$(jq -r '.mqtt_url // empty' $CONFIG_PATH)
USER_MQTT_USER=$(jq -r '.mqtt_user // empty' $CONFIG_PATH)
USER_MQTT_PASS=$(jq -r '.mqtt_pass // empty' $CONFIG_PATH)
POLL_INTERVAL=$(jq -r '.poll_interval' $CONFIG_PATH)
LOG_LEVEL=$(jq -r '.log_level' $CONFIG_PATH)

# Если в конфиге ничего не указано → fallback на Supervisor
if [ -n "$USER_MQTT_URL" ]; then
  MQTT_URL="$USER_MQTT_URL"
else
  MQTT_URL="mqtt://${SYSTEM_MQTT_HOST:-core-mosquitto}:${SYSTEM_MQTT_PORT:-1883}"
fi

if [ -n "$USER_MQTT_USER" ]; then
  MQTT_USER="$USER_MQTT_USER"
else
  MQTT_USER="$SYSTEM_MQTT_USER"
fi

if [ -n "$USER_MQTT_PASS" ]; then
  MQTT_PASS="$USER_MQTT_PASS"
else
  MQTT_PASS="$SYSTEM_MQTT_PASS"
fi

function needs_regen() {
  [ ! -f "$ENV_FILE" ] && return 0

  grep -q "TOKEN=" "$ENV_FILE" || return 0
  grep -q "SUBJECT_ID=" "$ENV_FILE" || return 0

  CURRENT_HASH=$(echo "$USERNAME|$PASSWORD|$AREA|$MQTT_USER|$MQTT_PASS|$MQTT_URL|$POLL_INTERVAL|$LOG_LEVEL" | sha256sum | cut -d' ' -f1)
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

  HASH=$(echo "$USERNAME|$PASSWORD|$AREA|$MQTT_USER|$MQTT_PASS|$MQTT_URL|$POLL_INTERVAL|$LOG_LEVEL" | sha256sum | cut -d' ' -f1)
  echo "CONFIG_HASH=$HASH" >> "$ENV_FILE"
else
  echo "✅ Existing .env is valid and matches config, skipping setup"
fi

echo "🚀 Starting Aqara G5 Pro integration..."
node dist/index.js

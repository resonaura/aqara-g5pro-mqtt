# Используем базовый образ Home Assistant (определяется через build.yaml)
ARG BUILD_FROM
FROM $BUILD_FROM

# Рабочая директория
WORKDIR /usr/src/app

# Устанавливаем Node.js 22.x (через NodeSource) и утилиты
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates jq gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Копируем исходники
COPY . ./

# Устанавливаем зависимости и собираем проект
RUN npm install && npm run build

# Копируем основной скрипт аддона
COPY addon.sh /usr/src/app/addon.sh
RUN chmod +x /usr/src/app/addon.sh

# Создаём сервис для s6-overlay
RUN mkdir -p /etc/services.d/aqara
COPY run.sh /etc/services.d/aqara/run
RUN chmod +x /etc/services.d/aqara/run

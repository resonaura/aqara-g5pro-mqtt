ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:latest
FROM $BUILD_FROM

# Рабочая директория
WORKDIR /usr/src/app

# Устанавливаем Node.js 22.x через NodeSource, сборочные утилиты и активируем pnpm
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg build-essential cmake git python3 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs jq ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.21.0 --activate

# Копируем манифесты и локфайлы для эффективного кэширования слоев
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Устанавливаем зависимости строго по локфайлу
RUN pnpm install --frozen-lockfile

# Копируем исходники
COPY . ./

# Собираем TypeScript проект и нативный C++ движок
RUN pnpm run build && pnpm run build:native

# Копируем стартовый скрипт и даём права на исполнение
COPY addon.sh /addon.sh
RUN chmod +x /addon.sh

# Указываем команду старта
CMD [ "/addon.sh" ]

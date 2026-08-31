ARG BUILD_FROM
FROM $BUILD_FROM

# Рабочая директория
WORKDIR /usr/src/app

# Устанавливаем Node.js 22.x через NodeSource и сборочные утилиты
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg build-essential cmake \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs jq ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Копируем исходники
COPY . ./

# Устанавливаем зависимости и собираем проект и нативный движок
RUN npm install && npm run build && npm run build:native

# Копируем стартовый скрипт и даём права на исполнение
COPY addon.sh /addon.sh
RUN chmod +x /addon.sh

# Указываем команду старта
CMD [ "/addon.sh" ]

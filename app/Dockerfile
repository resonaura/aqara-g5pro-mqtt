# Dockerfile для Home Assistant add-on Aqara G5 Pro
ARG BUILD_FROM
FROM $BUILD_FROM

# Рабочая директория
WORKDIR /usr/src/app

# Устанавливаем Node.js, npm и утилиты
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       nodejs npm jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Копируем исходники
COPY . ./

# Устанавливаем зависимости и собираем проект
RUN npm install && npm run build

# Копируем стартовый скрипт и даём права на исполнение
COPY addon.sh /addon.sh
RUN chmod +x /addon.sh

# Указываем команду старта
CMD [ "/addon.sh" ]

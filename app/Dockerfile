ARG BUILD_FROM
FROM $BUILD_FROM

WORKDIR /usr/src/app

# Устанавливаем Node.js 22 и утилиты
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates jq gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Копируем исходники и собираем
COPY . ./
RUN npm install && npm run build

# Стартовый скрипт
COPY addon.sh /addon.sh
RUN chmod +x /addon.sh

CMD [ "/addon.sh" ]

FROM node:22.16.0-slim

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig*.json ./
COPY config.yaml ./
COPY docker-compose.yaml ./
COPY .env.example ./

RUN npm install

COPY src ./src

RUN npm run build

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]

# Stage 1: Build
FROM node:22.16.0-slim AS build

WORKDIR /app

COPY ./app/package*.json ./
RUN npm install

# посмотреть, что появилось после установки
RUN ls -la /app

COPY ./app .
# посмотреть, что скопировалось
RUN ls -la /app

RUN npm run build
# проверить, создалась ли dist
RUN ls -la /app && ls -la /app/dist || true

# Stage 2: Run
FROM node:22.16.0-slim

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./

CMD ["node", "dist/index.js"]

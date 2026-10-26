# Stage 1: Build
FROM node:22.16.0-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates python3 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

# Install dependencies first (leverages layer caching)
COPY ./app/pnpm-lock.yaml ./app/pnpm-workspace.yaml ./app/package.json ./
RUN pnpm install --frozen-lockfile

# Build the app and native C++ engine
COPY ./app ./
RUN pnpm run build && pnpm run build:native && pnpm prune --prod

# Stage 2: Run
FROM node:22.16.0-slim

WORKDIR /app

RUN apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/native/build/aqara-streamer ./native/build/aqara-streamer
COPY --from=build /app/native/build/.source_hash ./native/build/.source_hash
COPY --from=build /app/package.json ./

RUN node dist/scripts/verify-runtime.js

CMD ["node", "dist/index.js"]

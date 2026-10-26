ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base-debian:bookworm
FROM ${BUILD_FROM} AS runtime-base

WORKDIR /usr/src/app

# Keep HA's bashio/curl entrypoint dependencies, Node and media tools at runtime.
RUN apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends curl ca-certificates gnupg \
    && curl --retry 2 --connect-timeout 15 --max-time 120 -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends nodejs jq ffmpeg \
    && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS build

RUN apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends build-essential cmake git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.21.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm install --frozen-lockfile
COPY . ./
RUN pnpm run build && pnpm run build:native && pnpm prune --prod

FROM runtime-base

COPY --from=build /usr/src/app/package.json ./
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/native/build/aqara-streamer ./native/build/aqara-streamer
COPY --from=build /usr/src/app/native/build/.source_hash ./native/build/.source_hash
COPY --chmod=755 addon.sh /addon.sh

# Verify the actual production ABI and shared libraries on each target CPU.
RUN node dist/scripts/verify-runtime.js

CMD ["/addon.sh"]

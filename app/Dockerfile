ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:latest
FROM $BUILD_FROM

# Working directory
WORKDIR /usr/src/app

# Install Node.js 22.x via NodeSource, build tools, and activate pnpm
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg build-essential cmake git python3 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs jq ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.21.0 --activate

# Copy package manifests and lockfiles for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Install dependencies strictly from lockfile
RUN pnpm install --frozen-lockfile

# Copy application source code
COPY . ./

# Build TypeScript application and native C++ engine
RUN pnpm run build && pnpm run build:native

# Copy entrypoint startup script and set execution permissions
COPY addon.sh /addon.sh
RUN chmod +x /addon.sh

# Entrypoint startup command
CMD [ "/addon.sh" ]

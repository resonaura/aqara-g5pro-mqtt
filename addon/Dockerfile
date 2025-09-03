# Use Home Assistant base with Node.js 22
ARG BUILD_FROM=ghcr.io/hassio-addons/base-nodejs:22
FROM $BUILD_FROM

WORKDIR /usr/src/app

# Copy sources
COPY ./src ./src
COPY package*.json ./

# Install deps & build
RUN npm install --omit=dev && npm run build

# Copy run script
COPY addon/run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]

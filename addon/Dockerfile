# Use Home Assistant base with Node.js 22
FROM node:22.16.0-slim

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

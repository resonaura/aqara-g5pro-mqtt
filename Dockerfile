# Use Node 22 (matches your host version)
FROM node:22.16.0-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package files first for caching
COPY package*.json ./

# Install dependencies
RUN npm i

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose nothing (only MQTT client is used)
CMD [ "npm", "start" ]

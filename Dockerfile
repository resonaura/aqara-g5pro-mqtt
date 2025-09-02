# Use Node 22 (matches your host version)
FROM node:22.16.0-slim

# Set working directory inside container
WORKDIR /app

# Copy package files first (для кэширования зависимостей)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy весь проект внутрь контейнера
COPY . .

# Build TypeScript
RUN npm run build

# Expose nothing (only MQTT client is used)
CMD [ "npm", "start" ]

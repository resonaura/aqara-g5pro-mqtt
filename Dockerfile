# Use Node 22 (matches your host version)
FROM node:22.16.0-slim

# Install dependencies
RUN npm i

# Build TypeScript
RUN npm run build

# Expose nothing (only MQTT client is used)
CMD [ "npm", "start" ]

# Stage 1: Build
FROM node:22.16.0-slim AS build

WORKDIR /app

COPY ../app .

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Stage 2: Run
FROM node:22.16.0-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./

CMD ["node", "dist/index.js"]

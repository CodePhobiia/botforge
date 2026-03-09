FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S botforge && adduser -S botforge -G botforge

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R botforge:botforge /app

USER botforge
EXPOSE 3000
CMD ["node", "src/api/server.js"]

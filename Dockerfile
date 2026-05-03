# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /app

RUN npm config set audit false \
    && npm config set fund false \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-factor 2 \
    && npm config set fetch-retry-mintimeout 10000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set fetch-timeout 600000

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --no-progress --loglevel=warn

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN npm run build \
    && npm prune --omit=dev --no-audit --no-fund --no-progress --loglevel=warn

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p uploads

EXPOSE 3001
CMD ["node", "dist/server.js"]

# ─── Stage 1: Build frontend ───
FROM oven/bun:1 AS frontend-build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/frontend/package.json packages/frontend/package.json
RUN bun install --frozen-lockfile
COPY packages/shared/ packages/shared/
COPY packages/frontend/ packages/frontend/
RUN cd packages/frontend && bun run build

# ─── Stage 2: Production server ───
FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/frontend/package.json packages/frontend/package.json
RUN bun install --frozen-lockfile --production
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY --from=frontend-build /app/packages/frontend/dist /app/static

ENV PORT=3000
ENV MESHEZIA_TOKEN=""
ENV DB_PATH="/data/meshezia.db"
ENV STATIC_DIR="/app/static"
ENV RATE_WINDOW_MS=60000
ENV RATE_MAX_REQUESTS=120

EXPOSE 3000
VOLUME /data

CMD ["bun", "run", "packages/server/src/index.ts"]

FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./

FROM oven/bun:1-slim AS runner
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package.json tsconfig.json ./

EXPOSE 8080

CMD ["bun", "run", "src/monitor/main.ts"]

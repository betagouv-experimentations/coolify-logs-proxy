FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --production --frozen-lockfile || bun install --production

FROM oven/bun:1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY index.ts package.json ./

EXPOSE 3000
ENV PORT=3000
CMD ["bun", "run", "index.ts"]

# Stage 1: Build & Dependencies
FROM node:22-alpine AS builder

WORKDIR /app

# Enable Corepack & pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package lockfiles
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code and config
COPY tsconfig.json ./
COPY src ./src

# Build production bundle to dist/
RUN pnpm build

# Install production dependencies only
RUN pnpm prune --prod

# Stage 2: Production Runtime
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV APP_PORT=3000

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# Copy built app and production dependencies
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Set file ownership
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${APP_PORT}/ || exit 1

CMD ["node", "dist/index.js"]

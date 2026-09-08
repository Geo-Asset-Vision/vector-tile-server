# ============================================================================
# Vector Tile Server — glibc (node:22-slim) build.
#
# The semantic catalog-search runtime loads an ONNX model through the native
# onnxruntime-node binding, which does not run on musl (Alpine). Both stages
# therefore use the Debian-based node:22-slim image.
#
# The ONNX model artifacts are baked in from the HOST copy at models/
# (gitignored; provisioned once per checkout with `pnpm semantic:prefetch`).
# The runtime NEVER downloads models; this image contains no model-fetch path
# and remote loading is hard-disabled in src/libs/semantic/embedding.ts.
# ============================================================================

# Stage 1: Build & Dependencies
FROM node:22-slim AS builder

WORKDIR /app

# onnxruntime-node's postinstall would fetch CUDA EP binaries from the NuGet
# feed on linux/x64. The CPU .node binary we need is already bundled in the
# npm tarball, so skip the network fetch.
ENV ONNXRUNTIME_NODE_INSTALL=skip

# Enable Corepack & pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package lockfiles + workspace config (pnpm 11 allowBuilds policy)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

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
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV APP_PORT=3000

# wget is used by the healthcheck (Debian slim has no wget/curl).
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

# Bake the prefetched ONNX model artifacts (host copy, see README / the
# `semantic:prefetch` script). Executed as root so the non-root user below can
# own the whole tree with read access.
COPY models ./models

# Copy built app and production dependencies
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# node:22-slim ships a 'node' user (uid 1000). Run as non-root; the model tree
# and app files are chowned to it (model artifacts are 644 by default — only
# READ access is granted, matching the read-only runtime contract).
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${APP_PORT}/ || exit 1

CMD ["node", "dist/index.js"]

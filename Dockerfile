# Pitchbox server image.
#
# Runs the Express/TypeScript server with `tsx` (no precompile): the server
# bundles its in-sandbox recorder from .ts source at runtime via esbuild, so the
# source tree must be present — a tsc `dist/` build would drop those .ts files.
#
# Includes ffmpeg (fusion + screenshot capture) and Chromium + its shared
# libraries (Puppeteer for URL recording and slate rendering). The Daytona
# sandbox path needs none of this on the host — it runs untrusted repos remotely.
# Node 22, not 20: @supabase/supabase-js reaches for a global WebSocket (via
# realtime-js) at import time, and that only exists natively from Node 22. On 20
# the server crashes on startup as soon as the Supabase client is constructed.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3001 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    RECORDER_CAPTURE_MODE=screenshot

# System deps: ffmpeg, Chromium, and the libraries Chromium needs to launch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg chromium ca-certificates fonts-liberation dumb-init \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libpangocairo-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install workspace deps. Copy manifests first for layer caching. EVERY
# workspace manifest is required: `npm ci` validates the tree against the shared
# lockfile and fails outright if one referenced there is missing from disk.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci

# Server source + base tsconfig (tsx reads TS directly).
COPY tsconfig.json ./
COPY apps/server ./apps/server

# Writable output dir for generated media (ephemeral unless a blob store is set).
RUN mkdir -p /app/recordings/sessions

EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "apps/server/src/index.ts"]

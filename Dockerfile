# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

# The locked development dependencies include workerd, which needs libatomic on Linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libatomic1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Keep locked versions and integrity hashes, using only the public npm registry.
RUN node -e 'const fs = require("node:fs"); const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")); for (const entry of Object.values(lock.packages)) { if (entry.resolved) entry.resolved = entry.resolved.replace("https://registry.npmmirror.com/", "https://registry.npmjs.org/"); } fs.writeFileSync("package-lock.json", JSON.stringify(lock));' \
    && npm ci --include=dev --registry=https://registry.npmjs.org --no-audit --no-fund

COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
# Vue components import shared utilities from functions/ during the Vite build.
COPY functions ./functions
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data

COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /app/data \
    && chown node:node /app/data

COPY --from=build /app/dist ./dist
COPY functions ./functions
COPY src/shared ./src/shared
COPY server ./server
COPY schema.sql ./schema.sql

USER node

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/api/public_config").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["node", "--experimental-sqlite", "server/index.js"]

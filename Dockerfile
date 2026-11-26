# Base images pinned by tag (readable, bumpable) and digest (immutable).

# --- Obsidian plugin build ---------------------------------------------------
FROM node:26.13.1-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS plugin-build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY esbuild.config.mjs tsconfig.json manifest.json styles.css ./
COPY src/ ./src/
RUN npm run build

# Only the installable plugin files. Exported as release assets via
# `docker buildx build --target plugin --output type=local,dest=dist .`
FROM scratch AS plugin
COPY --from=plugin-build /build/main.js /build/manifest.json /build/styles.css /

# --- Relay server ------------------------------------------------------------
FROM python:3.15.1-slim@sha256:533b0b2f9b5d46fd097091cf826f27902f1d6c3bca714b6dc74551356aa97a51

LABEL org.opencontainers.image.title="lanote" \
      org.opencontainers.image.description="LANote zero-knowledge relay server, bundling the matching Obsidian plugin" \
      org.opencontainers.image.source="https://github.com/pluggero/lanote" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Deps in their own layer: pip only re-runs when requirements.txt changes.
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/server.py .
COPY server/app/ ./app/
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && useradd --create-home --uid 1000 lanote \
    && mkdir -p /app/data \
    && chown -R lanote:lanote /app

# Root-owned and read-only for the server; extract with `docker cp` (docs/server.md).
COPY --from=plugin --chmod=0644 / /opt/lanote/plugin/

EXPOSE 4245
ENV PORT=4245 \
    DB_DIR=/app/data \
    PYTHONDONTWRITEBYTECODE=1

VOLUME ["/app/data"]

# No curl in the slim image; Python's urllib does the job.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:4245/', timeout=2)" || exit 1

# Starts as root to fix DB_DIR ownership, then drops to 'lanote'
# (see docker-entrypoint.sh).
ENTRYPOINT ["docker-entrypoint.sh"]

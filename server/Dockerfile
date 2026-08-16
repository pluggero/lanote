# Exact patch tag (not a floating "3.12"/"slim" tag) so rebuilds are
# reproducible and Renovate can track/bump it precisely.
FROM python:3.12.13-slim

WORKDIR /app

# Install deps in their own layer so `docker build` only re-runs pip when
# requirements.txt actually changes, not on every server.py edit.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY app/ ./app/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && useradd --create-home --uid 1000 lanote \
    && mkdir -p /app/data \
    && chown -R lanote:lanote /app

EXPOSE 4245
ENV PORT=4245 \
    DB_DIR=/app/data

VOLUME ["/app/data"]

# No curl in the slim image -- Python's own urllib avoids installing one.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:4245/', timeout=2)" || exit 1

# Container starts as root: the entrypoint fixes DB_DIR ownership (needed
# for bind mounts, see docker-entrypoint.sh) then drops to the unprivileged
# 'lanote' user before actually running the server.
ENTRYPOINT ["docker-entrypoint.sh"]

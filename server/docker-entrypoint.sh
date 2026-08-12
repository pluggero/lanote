#!/bin/sh
set -e

# A bind-mounted DB_DIR is created on the host by the Docker daemon (as
# root) before the container ever starts, which shadows whatever ownership
# the image set up at build time. Fix it here, as root, before dropping to
# the unprivileged 'lanote' user to actually run the server.
mkdir -p "$DB_DIR"
chown -R lanote:lanote "$DB_DIR"

exec su -s /bin/sh lanote -c "exec python server.py"

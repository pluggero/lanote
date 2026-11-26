# Relay Server

[← Back to README](../README.md)

The relay server stores and forwards encrypted bytes only — see [Security model](security.md) for what it can and can't see.

## Running it

### Docker image (recommended)

Each [release](https://github.com/pluggero/lanote/releases) publishes `ghcr.io/pluggero/lanote:<version>` (also `latest`) for amd64 and arm64. Run it with the same hardening as [`compose.yaml`](../compose.yaml): `read_only`, `cap_drop: ALL` + `CHOWN, SETUID, SETGID`, `no-new-privileges`, port bound to `127.0.0.1`, a volume on `/app/data`.

Verify the image before deploying:

```sh
gh attestation verify oci://ghcr.io/pluggero/lanote:<version> -R pluggero/lanote
```

### Docker from source

```sh
docker compose up -d   # at the repo root
```

Starts the relay on `127.0.0.1:4245`, persisting encrypted data under `server/data/`.

### Manual (Python)

```sh
cd server && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

## Serving the plugin to participants

The image bundles the matching plugin under `/opt/lanote/plugin/`. Copy it to the host after every pull, as an admin (not the `lanote` user):

```sh
id=$(docker create ghcr.io/pluggero/lanote:<version>)
docker cp "$id":/opt/lanote/plugin/. /home/lanote/lanote/
docker rm "$id"
chmod 0755 /home/lanote/lanote && chmod 0644 /home/lanote/lanote/*
```

`docker cp` reads the image without running it, and the relay container never gets write access to that folder. Participants then fetch it with `scp` (see [Join quickstart](join-quickstart.md)).

Restrict the `lanote` SSH user to the tunnel and read-only file access in `/etc/ssh/sshd_config`:

```
Match User lanote
    ForceCommand internal-sftp -R
    AllowTcpForwarding local
    PermitOpen localhost:4245
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
```

No shell or remote commands. `scp` works (OpenSSH ≥ 9.0 uses SFTP), and tunnels need `ssh -N`. Don't add `lanote` to the `docker` group: it is root-equivalent.

## Configuration

Entirely environment-variable driven (`server/app/config.py`) — no config file, no CLI flags.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4245` | TCP port the relay listens on. |
| `DB_DIR` | `server/data` | Where encrypted room data is persisted. |
| `MAX_UPLOAD_BYTES` | `209715200` (200 MiB) | Largest single file the relay will accept. |
| `MAX_PEERS_PER_ROOM` | `32` | Connection cap per room. |

A few operational constants are fixed rather than configurable: `AUTH_HANDSHAKE_TIMEOUT` (5s) and `WS_MAX_MSG_BYTES` (16 MiB).

## Exposing it beyond localhost

`compose.yaml` binds the relay to `127.0.0.1:4245:4245` by default, so only the host machine itself can reach it. To let other devices connect directly, change that mapping to `"4245:4245"` (or a specific interface IP).

The relay has no built-in TLS — see [Security model → Known limitations](security.md#known-limitations) before exposing it beyond a trusted local network.

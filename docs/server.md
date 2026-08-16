# Relay Server

[← Back to README](../README.md)

The relay server stores and forwards encrypted bytes only — see [Security model](security.md) for what it can and can't see.

## Running it

### Docker (recommended)

```sh
cd server && docker compose up -d
```

Starts the relay on `127.0.0.1:4245`, persisting encrypted data under `server/data/`. Bound to localhost only by default — see [Exposing it beyond localhost](#exposing-it-beyond-localhost) to change that.

### Manual (Python)

```sh
cd server && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

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

`server/docker-compose.yml` binds the relay to `127.0.0.1:4245:4245` by default, so only the host machine itself can reach it. To let other devices connect directly, change that mapping to `"4245:4245"` (or a specific interface IP).

The relay has no built-in TLS — see [Security model → Known limitations](security.md#known-limitations) before exposing it beyond a trusted local network.

# Getting Started

[← Back to README](../README.md)

This walks through going from nothing to two devices live-syncing a shared folder: installing the plugin, reaching a relay server, and creating or joining a room. For depth beyond what's here, see [Relay Server](server.md), [Security model](security.md), and [Supported file types](file-sync.md).

## Prerequisites

- An Obsidian vault with **Community plugins** enabled (Settings → Community plugins → Turn on community plugins).
- Node.js and npm, only if you're building the plugin from source (Option C below).
- An SSH keypair and access to the relay server's host, only if you'll reach it through an SSH tunnel rather than running it locally (step 2).

## 1. Install the plugin

**LANote is not published on the Obsidian Community Plugins store.** It's always a manual install, whichever way you get the build:

- **Option A: from the relay host.** Its version matches the relay:
  ```sh
  scp -6 -o PreferredAuthentications="publickey" -i <path/to/privatekey> -r lanote@[<relay-ip>]:/home/lanote/lanote .
  ```
  (Drop `-6` and the brackets for an IPv4 address.) This gives you a ready `lanote/` folder.
- **Option B: from a [release](https://github.com/pluggero/lanote/releases).** Download `main.js`, `manifest.json`, and `styles.css`.
- **Option C: build from source.**
  ```sh
  npm install
  npm run build   # or `npm run dev` to watch
  ```
  This produces `main.js` (gitignored) at the repo root.

Put `manifest.json`, `main.js`, and `styles.css` in `<vault>/.obsidian/plugins/lanote/`, then enable **LANote** under Settings → Community plugins. To verify a downloaded build, see [Security model → Plugin distribution](security.md#plugin-distribution).

## 2. Reach a relay server

**Run your own:** use the published image, or from source:
```sh
docker compose up -d   # at the repo root
```
See [Relay Server](server.md) for the manual/venv alternative and the full configuration reference.

**Connect to someone else's remote relay server.** If it isn't directly reachable (for example it's bound to localhost on a remote host), forward it over SSH:
```sh
ssh -N -L 4245:localhost:4245 lanote@<relay-host>
```
Keep that session open while syncing, and use `ws://localhost:4245` as the connection URL below. See [Security model](security.md#known-limitations) for why this matters: the relay has no built-in TLS.

In Obsidian, open **Settings → LANote → Server Connection** and set **Server Connection URL** to the relay's address (default `ws://localhost:4245`). To connect from another device on the same network instead, find that machine's local IP (e.g. with `ip addr` or `ipconfig`), for example `ws://192.168.1.12:4245`.

Two more controls live in this section: **Sync Check Interval (seconds)** (how often each room polls the relay, clamped to 2 to 300s) and **Reconnect All Files** (forces a reconnect with the current settings).

## 3. Host: create a room

Under **Create Room**, click **+ New Room**, set **Folder to Share** (or browse to an existing one), and click **Create Room**. The room appears in the list with a **Sharing** status badge.

Share the Room Code, and SSH access if the relay is remote, with whoever is joining, over a channel you trust. See [Security model](security.md#known-limitations): the same token that lets a device sync can also delete the room, so treat the code like a password.

## 4. Participant: join the room

Under **Join Room**, click **+ Join Room**, paste the Room Code you were given (format: `K7QM-9XJ2-4RTN-VB3W-XHNC-7SYA`), set **Destination Folder** (or browse to an existing one), and click **Join**. The room's status badge moves through **Connecting** and then **Connected** (or **Disconnected** / **Standby** if the relay is unreachable).

## 5. Verify it's working

Open the same note from the shared folder on both devices. You should see each other's live cursor while editing Markdown. Each room's list entry also has a **Sync Now** action, plus host-side **Renew ID**, **Reconstruct Server State**, **Start/Stop Sharing**, **Delete**, and participant-side **Leave**.

## Next steps

- [Relay Server](server.md): deployment and configuration reference.
- [Security model](security.md): threat model and known limitations.
- [Supported file types](file-sync.md): per-file-type conflict resolution.
- [Known issues](known-issues.md): bugs and workarounds in the current release.

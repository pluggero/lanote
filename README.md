# LANote

Real-time collaborative note editing over your local network, with a zero-knowledge relay server: it stores and forwards encrypted bytes only, never plaintext. Your encryption key is derived on-device from a shared room code and never leaves it.

Documentation: [Getting Started](docs/getting-started.md) · [Relay Server](docs/server.md) · [Security model](docs/security.md) · [Supported file types](docs/file-sync.md) · [Known issues](docs/known-issues.md) · [Changelog](CHANGELOG.md)

> **Known issues:** some sync bugs remain, e.g. files can revert after coming back online. Read [Known issues](docs/known-issues.md) before relying on LANote.

## Quick start

Relay server: `ghcr.io/pluggero/lanote` (see [Relay Server](docs/server.md)), or from source:

```sh
docker compose up -d
```

Plugin: download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/pluggero/lanote/releases/latest), or from your relay host, or build with `npm install && npm run build`. Put them in `<vault>/.obsidian/plugins/lanote/`, then enable it in Obsidian.

LANote is not published on the Obsidian Community Plugins store, so a manual install is the only way to get it. For the full walkthrough, including remote relay servers over SSH and creating or joining a room, see [Getting Started](docs/getting-started.md).

## License

MIT — see [LICENSE](LICENSE).

# LANote

Real-time collaborative note editing over your local network, with a
zero-knowledge relay server: it stores and forwards encrypted bytes only,
never plaintext. Your encryption key is derived on-device from a shared
room code and never leaves it.

Documentation: [Getting Started](docs/getting-started.md) ·
[Relay Server](docs/server.md) · [Security model](docs/security.md) ·
[Supported file types](docs/file-sync.md)

## Quick start

Relay server:

```sh
cd server && docker compose up -d
```

Plugin:

```sh
npm install
npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` into
`<vault>/.obsidian/plugins/lanote/`, then enable it in Obsidian.

LANote is not published on the Obsidian Community Plugins store, so this
manual install is the only way to get it. For the full walkthrough,
including remote relay servers over SSH and creating or joining a room, see
[Getting Started](docs/getting-started.md).

## License

MIT — see [LICENSE](LICENSE).

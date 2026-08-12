# LANote

Real-time collaborative note editing over your local network, with a
zero-knowledge relay server: it stores and forwards encrypted bytes only,
never plaintext. Your encryption key is derived on-device from a shared
room code and never leaves it.

## Server

```sh
cd server && docker compose up -d
```

Starts the relay on `127.0.0.1:4444`, persisting encrypted data under
`server/data/`. Edit the `ports:` mapping in `server/docker-compose.yml` to
expose it beyond localhost.

Without Docker:

```sh
cd server && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

## Plugin

```sh
npm install
npm run build   # or `npm run dev` to watch
```

Builds `main.js` at the repo root. Copy `manifest.json`, `main.js`, and this
repo into `<vault>/.obsidian/plugins/lanote/`, then enable it in Obsidian.

## Usage

1. Set **Server Connection URL** to the relay's address.
2. Pick a **Shared Folder** and generate a **Room Code**.
3. On other devices: same server address, same room code, any local shared
   folder.
4. Open a note inside the shared folder to see live cursors.

## License

MIT — see [LICENSE](LICENSE).

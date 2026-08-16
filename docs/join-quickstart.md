# Quickstart: Join a Room

[← Back to README](../README.md)

For participants joining a room where someone else already runs the relay server, has a plugin build ready to share, and will give you a Room Code directly. For every other case (running your own server, building from source, hosting a room), see [Getting Started](getting-started.md).

## What you need

- An Obsidian vault with Community plugins enabled (Settings → Community plugins → Turn on community plugins). Any vault works; use an empty one if you'd rather keep this plugin isolated from your other notes until you trust it.
- An SSH keypair. It is used to access the relay server's host.
- The plugin build (`manifest.json`, `main.js`, `styles.css`).
- The relay server's SSH address and a Room Code.

## Steps

1. Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/lanote/`, then enable **LANote** under Settings → Community plugins.
2. Settings → LANote → Your Profile → set **Collaborator Nickname** to something identifiable (defaults to "Anonymous"). This is the name others see next to your cursor.
3. Open a tunnel to the relay server and keep it open while syncing:
   ```sh
   ssh -L 4245:localhost:4245 user@host
   ```
4. In Obsidian: Settings → LANote → Server Connection → set **Server Connection URL** to `ws://localhost:4245`.
5. Settings → LANote → Join Room → **+ Join Room** → paste the **Room Code** you were given, set a **Destination Folder**, click **Join**.
6. Open a note inside the shared folder. You should see your host's live cursor, labeled with their nickname, while editing Markdown.

Full field-by-field detail: [Getting Started](getting-started.md). Why the SSH tunnel matters: [Security model](security.md#known-limitations).

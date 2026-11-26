# Quickstart: Join a Room

[← Back to README](../README.md)

For joining a room on someone else's relay. Running your own relay or hosting a room: see [Getting Started](getting-started.md).

Before you start, read the [Known issues](known-issues.md).

You get from the room host:

- relay-ip: `<relay-ip>`
- room-code: `<room-code>`

1. Send the room host your SSH public key, for access to the relay server.
2. Create a new Obsidian vault or open an existing one.
3. Download the plugin into the vault:
   ```sh
   mkdir -p <vault>/.obsidian/plugins && cd <vault>/.obsidian/plugins
   scp -6 -o PreferredAuthentications="publickey" -i <path/to/privatekey> -r lanote@[<relay-ip>]:/home/lanote/lanote .
   ```
   For IPv4, drop `-6` and the brackets. Optional: [verify the build](security.md#plugin-distribution).
4. In Obsidian: Settings → Community plugins → turn on community plugins, then enable **LANote**.
5. Open an SSH tunnel to the relay and keep it open while syncing:
   ```sh
   ssh -N -L 4245:localhost:4245 -i <path/to/privatekey> lanote@<relay-ip>
   ```
6. Settings → LANote → Your Profile → set **Collaborator Nickname** (others see it next to your cursor).
7. Settings → LANote → Server Connection → set **Server Connection URL** to `ws://localhost:4245`.
8. Settings → LANote → Join Room → **+ Join Room** → paste the room-code, pick a destination folder in your vault, click **Join**.
9. Open a note in that folder and start collaborating.

Details: [Getting Started](getting-started.md). Why the tunnel: [Security model](security.md#known-limitations).

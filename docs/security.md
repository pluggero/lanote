# Security model

[← Back to README](../README.md)

Every device derives the same set of keys from the room code you type in (PBKDF2, then HKDF). None of them ever leave the device or reach the relay server:

- An **AES-GCM key** that encrypts file contents, file names, and live-editing state.
- An **HMAC key** that turns each file's path into an opaque, one-way token. The relay server stores and looks files up by this token, never by the real path.
- A **bearer token** and **room ID**, derived the same way, which _are_ sent to the relay server. They're what it uses to authorize requests and address the room, and they reveal nothing about the room code or the encryption key they came from.

The relay server only ever sees ciphertext, file sizes/timestamps, opaque path tokens, and that bearer token/room ID. It never sees your room code, your encryption key, a real file path, or any plaintext.

**Authentication** is trust-on-first-use: the first bearer token presented for a room ID becomes that room's credential, and every later request must present the same one. There's no separate login step or password; knowing the room code _is_ the credential.

## Threat model

Anyone with the room code can read and write every file in the shared folder. A malicious peer can:

- **Change or delete files.** Keep backups.
- **Run code** through plugins that execute vault content (Templater, DataviewJS, CustomJS, Shell commands). Keep their script folders outside the shared folder and prevent inline scripts from running.
- **Drop harmful files** (scripts, executables, macros). Don't open files you don't trust.
- **Fill your disk** (up to 200 MB per file).

Peers can't write outside the shared folder: unsafe file names are skipped. The relay server can't read or forge files, but can drop them or serve old versions.

## Plugin distribution

`main.js` runs inside Obsidian with access to your vault and room code, so a tampered build defeats the encryption. If you got it from a relay host, you trust its operator. To check it matches a release, download that release's `SHA256SUMS` into the plugin folder, then:

```sh
sha256sum -c SHA256SUMS
gh attestation verify main.js -R pluggero/lanote   # alternative: check build provenance
```

## Known limitations

- **No built-in TLS.** The relay server speaks plain HTTP/WS, so nothing encrypts the connection itself. Content stays end-to-end encrypted regardless (the relay server never has the key), but the bearer token is sent unencrypted, so anyone observing the raw connection can capture it. **Workaround:** put a real transport-security layer in front of it yourself: a reverse proxy terminating TLS (Caddy/nginx), a WireGuard/Tailscale tunnel, or plain SSH local port forwarding all work.
  ```sh
  ssh -L 4245:localhost:4245 you@server
  ```
  Then point the plugin's Server Connection URL at `ws://localhost:4245`.
- **One token, full access.** The bearer token that lets a device sync also lets it permanently delete the room; there's no separate read-only credential. **Workaround:** treat the room code like a password. Share it only over a channel you trust, only with people you'd also trust to wipe the room, and create a fresh room if you ever suspect it leaked.
- **First-come-first-served room claiming.** Whoever presents a token for a room ID first "owns" it from then on; there's no registration step. **Workaround:** always use the app's generated room code (120 bits of randomness) rather than a memorable phrase you invent yourself, and start syncing on your first device right after creating a room.
- **Room code stored in plaintext on disk**, so the plugin can reconnect automatically. **Workaround:** rely on your device's disk encryption, and make sure `.obsidian/plugins/lanote/data.json` isn't swept up by backup or sync tools you don't fully trust with your other credentials.

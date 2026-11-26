# Known issues

[← Back to README](../README.md)

Known bugs in the current release. Fixes ship in later releases, see the [Changelog](../CHANGELOG.md).

## Bugs

- **Files revert after coming back online.** If you were offline while others kept syncing, some files can switch back to an older state when you reconnect. **Workaround:** the user who reconnected presses Ctrl+Z (Cmd+Z on macOS) in the affected file.
- **Offline edits lost on concurrent changes.** You edit a file offline while another peer edits the same file online. You then reconnect with that file still open, switch to another file and back. Your offline changes are discarded. **Workaround:** avoid offline edits to files others are working on, or copy your changes elsewhere before reconnecting.
- **Renamed file keeps coming back.** A file copied into the vault from outside Obsidian and renamed before it finished syncing can end up duplicated. Deleting the duplicate doesn't stick. **Workaround:** wait until a new file has synced before renaming it.
- **"Standby" shown for synced files.** Some files show **Standby** although they sync normally. Display only.
- **Deleted rooms not detected.** If a room is deleted on the relay, joined devices don't notice and look as if they are still in the room. **Workaround:** ask the host, then leave the room and join a new one.

## Limitations

- **No version check between plugin and relay.** Use the plugin from the same release as the relay, ideally the copy served by the relay host ([Join quickstart](join-quickstart.md)).
- **No connection-loss alert.** Losing the relay connection only shows in the room's status badge.
- **"Delete" removes the room from the relay only.** Your local notes stay.

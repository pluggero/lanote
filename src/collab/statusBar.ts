import type LANotePlugin from '../main';

export function updateStatusBar(plugin: LANotePlugin) {
  if (!plugin.statusBarItem) return;

  if (plugin.simulatorInterval) {
    plugin.statusBarItem.setText('LANote 🟣 Simulating');
    return;
  }

  const hasAnyRoom = plugin.settings.hostedRooms.some(r => r.sharingActive) || plugin.settings.joinedRooms.length > 0;
  if (!hasAnyRoom) {
    plugin.statusBarItem.setText('LANote ⚪ Not configured');
    return;
  }

  let connected = 0;
  let connecting = 0;
  for (const sync of plugin.activeSyncs.values()) {
    if (!sync.provider) continue;
    if (sync.provider.wsconnected) connected++;
    else if (!sync.provider.wsconnected && sync.provider.shouldConnect) connecting++;
  }

  if (connected > 0) {
    plugin.statusBarItem.setText(`LANote 🟢 ${connected} synced`);
  } else if (connecting > 0) {
    plugin.statusBarItem.setText('LANote 🟡 Connecting...');
  } else if (plugin.activeSyncs.size > 0) {
    plugin.statusBarItem.setText('LANote 🔴 Disconnected');
  } else {
    plugin.statusBarItem.setText('LANote ⚪ Standby');
  }
}

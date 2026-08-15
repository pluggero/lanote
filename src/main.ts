import { Plugin, TFile, WorkspaceLeaf, MarkdownView, debounce } from 'obsidian';
import { LANoteSettingTab } from './settings/SettingsTab';
import { type LANoteSettings, type HostedRoom, type JoinedRoom, loadSettings, saveSettings } from './lib/settingsStore';
import type { ConnectionStatus, RoomRuntime, SyncSession } from './lib/types';
import { findHostedOrJoinedRoomForPath, getBackgroundSyncDebouncer, activeWireRelPathsForRoom, syncRoom } from './room/roomLookup';
import { teardownSyncSession } from './room/sessionTeardown';
import { reinitializeAllRooms } from './room/roomRuntime';
import {
  createRoom, startSharing, stopSharing, deleteHostedRoom, renewRoomId,
  joinRoom, leaveRoom, reconstructDatabase,
} from './room/roomActions';
import { syncFile, cleanupClosedFiles, reconnectAll, getDiskSyncDebouncer, handleFileRename, abandonActiveSync, abandonAndCloseFile } from './collab/collabSession';
import { detachStaleEditorBinding, collabCompartment } from './collab/editorBinding';
import { syncActiveCanvasCard, teardownAllCanvasCardSessions, type CanvasCardBinding } from './collab/canvasCardSession';
import { updateStatusBar } from './collab/statusBar';
import { toggleSimulator } from './collab/simulator';
import { cleanupAndMergeConflicts } from './sync/conflictMerge';
import { clampSyncIntervalSeconds } from './sync/syncInterval';
import { consumeSyncDrivenDeletion } from './lib/vaultFs';

export default class LANotePlugin extends Plugin {
  settings!: LANoteSettings;
  public activeSyncs: Map<string, SyncSession> = new Map();
  // One live session per actively-focused canvas text card, keyed by
  // "vaultRelPath\0nodeId" (canvasCardSession.ts's cardKey). Separate from
  // activeSyncs since a card has no TFile/leaf of its own to key by.
  public activeCardSyncs: Map<string, CanvasCardBinding> = new Map();
  // Non-persisted runtime state (derived keys + sync engine) for every
  // currently-live room, keyed by stable local id (HostedRoom.id /
  // JoinedRoom.id) rather than the crypto-derived roomId, which changes on renew.
  public roomRuntimes: Map<string, RoomRuntime> = new Map();
  public simulatorInterval: any = null;
  public statusBarItem: HTMLElement | null = null;
  public diskDebouncers: Map<string, (file: TFile) => void> = new Map();
  public connectionStatus: ConnectionStatus = 'disconnected';
  public retryTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private settingsTab: LANoteSettingTab | null = null;
  // One debounced background-sync trigger per room, so one room's background
  // sync doesn't force a rescan of every other room's folder.
  public backgroundSyncDebouncers: Map<string, () => void> = new Map();
  // Raw id of the current periodic-sync setInterval, so restartPeriodicSyncInterval() can clear and replace it when the user changes syncIntervalSeconds.
  // Typed as DOM's `number` (not @types/node's Timeout) because registerInterval() requires it -- only window.setInterval/window.clearInterval return that.
  private periodicSyncIntervalId: number | null = null;

  async onload() {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();
    updateStatusBar(this);

    this.registerEditorExtension(collabCompartment.of([]));

    await this.reinitializeAllRooms();

    // Commands
    this.addRibbonIcon('users', 'Simulate Collaborator Activity', () => {
      toggleSimulator(this);
    });

    this.addCommand({
      id: 'toggle-collaborator-simulation',
      name: 'Simulate Remote Collaborator Activity',
      callback: () => { toggleSimulator(this); }
    });

    this.addCommand({
      id: 'reconnect-all',
      name: 'Reconnect All Files',
      callback: () => { reconnectAll(this); }
    });

    this.addCommand({
      id: 'merge-conflicts',
      name: 'Merge and Clean Up Conflict Files',
      callback: () => { cleanupAndMergeConflicts(this.app); }
    });

    this.settingsTab = new LANoteSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Listen to file opens. active-leaf-change is Obsidian's authoritative
    // "this transition just happened and settled" signal -- unlike
    // layout-change (below), iterateAllLeaves() is trustworthy here, so
    // clean up whatever's no longer open right alongside starting the new
    // file's sync, instead of waiting on a timing-based heuristic.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
        if (!leaf) return;
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file) {
          detachStaleEditorBinding(this, view);
          syncFile(this, view.file);
        }
        cleanupClosedFiles(this);
      })
    );

    // Debounced safety net for closures active-leaf-change doesn't cover
    // (e.g. closing a tab outright via its close button, with no other leaf
    // becoming newly active). Debounced (trailing) because layout-change can
    // fire several times in a row during one multi-step UI transition.
    const cleanupClosedFilesDebounced = debounce(() => cleanupClosedFiles(this), 300, true);
    this.registerEvent(this.app.workspace.on('layout-change', cleanupClosedFilesDebounced));

    // Canvas cards have no per-card focus event, so their live session
    // lifecycle is driven off real DOM focus instead (canvasCardSession.ts).
    this.registerDomEvent(document, 'focusin', () => syncActiveCanvasCard(this));

    // Sync disk changes back into Yjs
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          getDiskSyncDebouncer(this, file.path)(file);
        }
      })
    );

    // Background per-room folder syncing (like Obsidian LiveSync, but E2E encrypted)
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        // If it's not currently open, sync it in the background
        if (file instanceof TFile && !this.activeSyncs.has(file.path)) {
          const match = findHostedOrJoinedRoomForPath(this, file.path);
          if (match) getBackgroundSyncDebouncer(this, match.room.id)();
        }
      })
    );
    this.registerEvent(this.app.vault.on('create', (file) => {
      const match = findHostedOrJoinedRoomForPath(this, file.path);
      if (match) getBackgroundSyncDebouncer(this, match.room.id)();
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) {
        if (consumeSyncDrivenDeletion(file.path)) return;
        abandonActiveSync(this, file.path);
        const match = findHostedOrJoinedRoomForPath(this, file.path);
        if (match) {
          this.roomRuntimes.get(match.room.id)?.configSyncEngine.deleteRemoteFile(file.path);
          getBackgroundSyncDebouncer(this, match.room.id)();
        }
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      handleFileRename(this, file, oldPath);
    }));

    // Automatically check for remote room-folder changes on a timer
    this.restartPeriodicSyncInterval();

    // Sync the currently active file
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      syncFile(this, activeView.file);
    }
  }

  onunload() {
    if (this.simulatorInterval) {
      clearInterval(this.simulatorInterval);
      this.simulatorInterval = null;
    }
    for (const timeout of this.retryTimeouts.values()) clearTimeout(timeout);
    this.retryTimeouts.clear();

    // Obsidian's onunload() is synchronous (can't be awaited), so this is
    // best-effort: it'll complete for a normal plugin disable/reload, but a
    // hard app quit can still cut it short -- the other peers' own 30s Yjs
    // awareness timeout is the fallback for that case.
    for (const [path, sync] of this.activeSyncs.entries()) {
      teardownSyncSession(this, path, sync);
    }
    this.activeSyncs.clear();
    teardownAllCanvasCardSessions(this);
  }

  // Thin delegations to room/roomActions.ts, room/roomRuntime.ts, room/roomLookup.ts,
  // and collab/collabSession.ts -- kept as methods since settings/*.ts and modals.ts
  // call them as plugin.xxx(...).

  public async createRoom(sharedFolder: string): Promise<HostedRoom> {
    return createRoom(this, sharedFolder);
  }

  public async startSharing(localRoomId: string): Promise<void> {
    return startSharing(this, localRoomId);
  }

  public async stopSharing(localRoomId: string): Promise<void> {
    return stopSharing(this, localRoomId);
  }

  public async deleteHostedRoom(localRoomId: string): Promise<void> {
    return deleteHostedRoom(this, localRoomId);
  }

  public async renewRoomId(localRoomId: string): Promise<void> {
    return renewRoomId(this, localRoomId);
  }

  public async joinRoom(roomSecret: string, sharedFolder: string): Promise<JoinedRoom> {
    return joinRoom(this, roomSecret, sharedFolder);
  }

  public async leaveRoom(localRoomId: string): Promise<void> {
    return leaveRoom(this, localRoomId);
  }

  public async reconstructDatabase(localRoomId: string): Promise<void> {
    return reconstructDatabase(this, localRoomId);
  }

  public activeWireRelPathsForRoom(localRoomId: string): Set<string> {
    return activeWireRelPathsForRoom(this, localRoomId);
  }

  // Direct syncConfig() call, not getBackgroundSyncDebouncer -- a periodic tick has no burst to coalesce, and syncConfig()'s isSyncing guard already makes overlapping calls safe.
  public restartPeriodicSyncInterval(): void {
    if (this.periodicSyncIntervalId !== null) window.clearInterval(this.periodicSyncIntervalId);
    const intervalMs = clampSyncIntervalSeconds(this.settings.syncIntervalSeconds) * 1000;
    this.periodicSyncIntervalId = window.setInterval(() => {
      for (const roomId of this.roomRuntimes.keys()) syncRoom(this, roomId, true);
    }, intervalMs);
    this.registerInterval(this.periodicSyncIntervalId);
  }

  public abandonAndCloseFile(path: string): void {
    return abandonAndCloseFile(this, path);
  }

  public async reinitializeAllRooms(): Promise<void> {
    return reinitializeAllRooms(this);
  }

  public reconnectAll(): void {
    reconnectAll(this);
  }

  async loadSettings(): Promise<void> {
    return loadSettings(this);
  }

  async saveSettings(): Promise<void> {
    return saveSettings(this);
  }
}

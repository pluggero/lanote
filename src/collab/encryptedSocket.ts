import { type RoomKeys, encryptBytes, decryptBytes, makeAAD } from '../lib/crypto';

// y-websocket's WebsocketProvider accepts a `WebSocketPolyfill` class and talks
// to it purely via property assignment (`.onopen`, `.onmessage`, `.onerror`,
// `.onclose`, `.binaryType`) plus `.send()`/`.close()`/`.readyState` -- see
// `setupWS` in node_modules/y-websocket/src/y-websocket.js. This wraps a real
// WebSocket via composition (not `extends WebSocket`): subclassing would mean
// this class's own message listener could catch its own re-dispatched,
// already-decrypted event and try to decrypt it a second time.
export function makeEncryptingWebSocket(roomKeys: RoomKeys): typeof WebSocket {
  const aad = makeAAD(roomKeys.roomId, 'ws');

  class EncryptingWebSocket {
    static readonly CONNECTING = WebSocket.CONNECTING;
    static readonly OPEN = WebSocket.OPEN;
    static readonly CLOSING = WebSocket.CLOSING;
    static readonly CLOSED = WebSocket.CLOSED;

    // Instance copies of the same constants: y-websocket's broadcastMessage()
    // checks `ws.readyState === ws.OPEN` on the *instance* (not the class),
    // and static members aren't reachable through instance property lookup.
    // Without these, that comparison is always `readyState === undefined`,
    // so every send after the initial handshake gets silently dropped.
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;

    private raw: WebSocket;
    // Chains encrypt/decrypt operations so frames are applied to the wire (or
    // to the caller's onmessage) in the same order they were sent/received --
    // otherwise concurrent async encrypt/decrypt calls could resolve out of
    // order, and Yjs's sync protocol assumes ordered delivery.
    private sendQueue: Promise<void> = Promise.resolve();
    private recvQueue: Promise<void> = Promise.resolve();

    public onopen: ((ev: Event) => void) | null = null;
    public onclose: ((ev: CloseEvent) => void) | null = null;
    public onerror: ((ev: Event) => void) | null = null;
    public onmessage: ((ev: MessageEvent) => void) | null = null;

    constructor(url: string) {
      this.raw = new WebSocket(url);
      this.raw.binaryType = 'arraybuffer';

      this.raw.onopen = (ev) => {
        // Raw, unencrypted: the one-time bearer credential the server uses
        // to admit this connection to the room's relay set (see server.py).
        // Everything after this frame is AEAD ciphertext.
        this.raw.send(roomKeys.authToken);
        this.onopen?.(ev);
      };
      this.raw.onclose = (ev) => this.onclose?.(ev);
      this.raw.onerror = (ev) => this.onerror?.(ev);
      this.raw.onmessage = (ev: MessageEvent) => {
        this.recvQueue = this.recvQueue.then(async () => {
          try {
            const plaintext = await decryptBytes(roomKeys.encKey, ev.data as ArrayBuffer, aad);
            this.onmessage?.(new MessageEvent('message', { data: plaintext }));
          } catch (e) {
            console.error('[LANote] dropping undecryptable frame', e);
          }
        });
      };
    }

    get readyState(): number {
      return this.raw.readyState;
    }

    get binaryType(): BinaryType {
      return this.raw.binaryType;
    }

    set binaryType(_value: BinaryType) {
      // y-websocket always sets this to 'arraybuffer'; already forced above,
      // and onmessage always hands callers a plain ArrayBuffer, so there is
      // nothing else to configure here.
    }

    send(data: ArrayBufferView | ArrayBuffer): void {
      const plaintext = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      this.sendQueue = this.sendQueue.then(async () => {
        const envelope = await encryptBytes(roomKeys.encKey, plaintext as ArrayBuffer, aad);
        // The await above means `close()` may have already been called (and
        // the socket moved to CLOSING/CLOSED) by the time we get here --
        // mirror the readyState guard y-websocket's own broadcastMessage()
        // already applies before calling send() in the first place, instead
        // of letting the browser log a warning and silently drop the frame.
        if (this.raw.readyState === WebSocket.OPEN) {
          this.raw.send(envelope);
        }
      });
    }

    close(code?: number, reason?: string): void {
      this.raw.close(code, reason);
    }
  }

  return EncryptingWebSocket as unknown as typeof WebSocket;
}

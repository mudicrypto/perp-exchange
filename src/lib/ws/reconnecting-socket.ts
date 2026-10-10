import type { ConnectionState } from "@/core/ports";

/** The subset of the WebSocket API we rely on (makes testing with fakes easy). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** 0..1 — fraction of the delay that is randomised. */
  jitter: number;
}

export interface HeartbeatOptions {
  intervalMs: number;
  /** If no message arrives within this window after a ping, reconnect. */
  timeoutMs: number;
  pingPayload: string;
}

export interface ReconnectingSocketOptions {
  url: string;
  createSocket?: SocketFactory;
  backoff?: Partial<BackoffOptions>;
  heartbeat?: HeartbeatOptions | null;
  now?: () => number;
  random?: () => number;
}

const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 500, maxMs: 30_000, factor: 2, jitter: 0.3 };

export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number): number {
  const base = Math.min(options.maxMs, options.initialMs * options.factor ** Math.max(0, attempt - 1));
  const spread = base * options.jitter;
  return Math.round(base - spread + random() * spread * 2);
}

/**
 * WebSocket wrapper with exponential backoff, a heartbeat watchdog and
 * open-hooks used to replay subscriptions. It deliberately knows nothing
 * about any venue's message format.
 */
export class ReconnectingSocket {
  private socket: SocketLike | null = null;
  private state: ConnectionState = { status: "idle" };
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly messageListeners = new Set<(raw: string) => void>();
  private readonly openListeners = new Set<() => void>();
  private readonly backoff: BackoffOptions;
  private readonly createSocket: SocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: ReconnectingSocketOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === OPEN && this.state.status === "open";
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(reason = "stopped"): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      socket.close(1000, reason);
    }
    this.setState({ status: "closed", reason });
  }

  /** Drop the current connection and reconnect immediately (e.g. browser came back online). */
  reconnectNow(reason = "manual reconnect"): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.teardownSocket();
    this.connect(reason);
  }

  /** Returns false if the socket is not open; callers replay state via onOpen. */
  send(payload: string): boolean {
    if (!this.isOpen || !this.socket) return false;
    this.socket.send(payload);
    return true;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: (raw: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  private connect(reason?: string): void {
    this.attempt += 1;
    this.setState({ status: "connecting", attempt: this.attempt });
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.options.url);
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : (reason ?? "connect failed"));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState({ status: "open", since: this.now() });
      this.startHeartbeat();
      for (const listener of this.openListeners) listener();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.clearPongDeadline();
      if (typeof event.data !== "string") return;
      for (const listener of this.messageListeners) listener(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      if (!this.stopped) this.scheduleReconnect(event.reason || `closed (${event.code ?? "?"})`);
    };
    socket.onerror = () => {
      // The browser follows `error` with `close`; reconnection is handled there.
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt + 1, this.backoff, this.random);
    this.setState({
      status: "reconnecting",
      attempt: this.attempt + 1,
      nextRetryAt: this.now() + delay,
      reason,
    });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect(reason);
    }, delay);
  }

  private startHeartbeat(): void {
    const heartbeat = this.options.heartbeat;
    if (!heartbeat) return;
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.send(heartbeat.pingPayload)) return;
      if (this.pongDeadline) return;
      this.pongDeadline = setTimeout(() => {
        this.pongDeadline = null;
        this.teardownSocket();
        this.scheduleReconnect("heartbeat timeout");
      }, heartbeat.timeoutMs);
    }, heartbeat.intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongDeadline();
  }

  private clearPongDeadline(): void {
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    this.pongDeadline = null;
  }

  private teardownSocket(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      try {
        socket.close(4000, "reconnecting");
      } catch {
        // ignore close errors on a broken socket
      }
    }
  }

  private detach(socket: SocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

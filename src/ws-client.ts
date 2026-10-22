import WebSocket from 'ws';

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (err: any) => void;
}

export interface StreamEvent {
  subscriptionId: string;
  type: string;
  data: Record<string, unknown>;
  skipped?: number;
}

export interface StreamErrorEvent {
  subscriptionId: string;
  code: string;
  message: string;
}

/**
 * Thin WebSocket client for the UiAutomator2 server's /ws/stream endpoint.
 * Handles the JSON-RPC-like protocol: subscribe, unsubscribe, and event streaming.
 */
export class StreamWsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, (event: StreamEvent) => void>();
  private errorHandlers = new Map<string, (err: StreamErrorEvent) => void>();
  private connected = false;

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => {
        this.connected = true;
        resolve();
      });
      this.ws.once('error', reject);
    });

    this.ws.on('message', (buf: Buffer) => {
      const msg = JSON.parse(buf.toString());

      // stream.event — push from server
      if (msg.method === 'stream.event') {
        const params = msg.params;
        const handler = this.eventHandlers.get(params.subscriptionId);
        handler?.(params as StreamEvent);
        return;
      }

      // Terminal per-subscription error push (id: null, error.subscriptionId set) —
      // e.g. a handler-level timeout or a stale element hit mid-stream.
      if (msg.id === null && msg.error?.subscriptionId) {
        const handler = this.errorHandlers.get(msg.error.subscriptionId);
        handler?.({
          subscriptionId: msg.error.subscriptionId,
          code: msg.error.code,
          message: msg.error.message,
        });
        return;
      }

      // RPC response (ack or error)
      if (typeof msg.id === 'number') {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      // Reject all pending requests
      for (const [, p] of this.pending) {
        p.reject(new Error('WebSocket closed'));
      }
      this.pending.clear();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async subscribe(params: {
    sessionId?: string;
    type: string;
    intervalMs: number;
    subscriptionId: string;
    [key: string]: unknown;
  }): Promise<any> {
    return this.request('stream.subscribe', params);
  }

  async unsubscribe(subscriptionId: string): Promise<any> {
    return this.request('stream.unsubscribe', { subscriptionId });
  }

  onEvent(subscriptionId: string, handler: (event: StreamEvent) => void): void {
    this.eventHandlers.set(subscriptionId, handler);
  }

  offEvent(subscriptionId: string): void {
    this.eventHandlers.delete(subscriptionId);
  }

  onError(subscriptionId: string, handler: (err: StreamErrorEvent) => void): void {
    this.errorHandlers.set(subscriptionId, handler);
  }

  offError(subscriptionId: string): void {
    this.errorHandlers.delete(subscriptionId);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.connected = false;
    this.eventHandlers.clear();
    this.errorHandlers.clear();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

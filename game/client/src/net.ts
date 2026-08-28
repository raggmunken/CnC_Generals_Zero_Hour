/** WebSocket transport. Reconnects, because a dropped socket should not end play. */
import type { ClientMsg, ServerMsg } from "../../shared/protocol.js";

export class Net {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private reconnectDelay = 500;

  onMessage: (msg: ServerMsg) => void = () => {};
  onStatus: (status: string) => void = () => {};

  constructor(url?: string) {
    if (url) {
      this.url = url;
    } else {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this.url = `${proto}//${location.host}/ws`;
    }
  }

  connect(): void {
    this.onStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.onStatus("connected");
    };

    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data as string) as ServerMsg);
      } catch {
        // A malformed frame is not worth tearing the session down for.
      }
    };

    ws.onclose = () => {
      this.onStatus("disconnected");
      // Back off so a server restart does not get hammered.
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
    };

    ws.onerror = () => ws.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

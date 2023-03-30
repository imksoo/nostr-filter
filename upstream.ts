import WebSocket from "ws";
class UpstreamNostrRelay {
  protected upstreamWebSocket: WebSocket;
  protected downstreamSocket: WebSocket;

  constructor(url: string, downstreamSocket: WebSocket) {
    this.upstreamWebSocket = new WebSocket(url);
    this.downstreamSocket = downstreamSocket;

    this.downstreamSocket.addEventListener("close", () => {
      this.upstreamWebSocket.close();
    });
    this.upstreamWebSocket.addEventListener("close", () => {
      this.downstreamSocket.close();
    });
  }
}

export class UpstreamNostrEventWriter extends UpstreamNostrRelay {
  constructor(event: string, url: string, downstreamSocket: WebSocket) {
    super(url, downstreamSocket);

    this.upstreamWebSocket.addEventListener("open", () => {
      this.upstreamWebSocket.send(event);
    });
    this.upstreamWebSocket.on("message", (data: WebSocket.Data) => {
      const msg = data.toString();
      this.downstreamSocket.send(msg);

      const event = JSON.parse(msg);
      if (event[0] === 'OK') {
        this.upstreamWebSocket.send(JSON.stringify(['CLOSE', event[1]]))
      }
    });
  }
}


export class UpstreamNostrReqListener extends UpstreamNostrRelay {
  constructor(req: string, url: string, downstreamSocket: WebSocket) {
    super(url, downstreamSocket);

    this.upstreamWebSocket.addEventListener("open", () => {
      this.upstreamWebSocket.send(req);
    });
    this.upstreamWebSocket.on("message", (data: WebSocket.Data) => {
      const msg = data.toString();
      this.downstreamSocket.send(msg);

      const event = JSON.parse(msg);
      if (event[0] === 'CLOSE') {
        this.upstreamWebSocket.send(JSON.stringify(['CLOSE', event[1]]))
      }
    });
  }
}

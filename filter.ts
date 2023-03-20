import { IncomingMessage } from "http";
import WebSocket from "ws";

const listenUrl = "ws://localhost:8081"; // クライアントからのWebSocket接続先のURL
const upstreamUrl = "ws://localhost:8080"; // 上流のWebSocketサーバのURL

const filters = [/^avive/i, /web3$/i]; // 正規表現パターンの配列

function listen() {
  const wss = new WebSocket.Server({ port: 8081 });
  wss.on("connection", (clientStream: WebSocket, req: IncomingMessage) => {
    // console.log("WebSocket connected");

    let upstreamSocket = new WebSocket(upstreamUrl);
    connectUpstream(upstreamSocket, clientStream);

    clientStream.on("message", async (data: WebSocket.Data) => {
      const message = data.toString();

      const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      if (message.indexOf("EVENT") > -1) {
        console.log(`${ip}: ${message}`);
      }

      let shouldRelay = true;
      for (const filter of filters) {
        if (filter.test(message)) {
          // 正規表現パターンにマッチする場合はコンソールにログ出力
          console.log(`${ip}: ${message}`);
          shouldRelay = false;
          break;
        }
      }
      if (shouldRelay) {
        // 正規表現パターンにマッチしない場合は上流のWebSocketに送信
        if (upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(message);
        }
      }
    });

    clientStream.on("close", () => {
      // console.log("WebSocket disconnected");
    });

    clientStream.on("error", (error: Error) => {
      console.log("WebSocket error:", error);
    });

    clientStream.pong = () => {
      clientStream.ping();
    };
  });
  console.log(`WebSocket server listening on ${listenUrl}`);
}

function connectUpstream(upstreamSocket: WebSocket, clientStream: WebSocket) {
  upstreamSocket.on("open", () => {
    // console.log("Upstream WebSocket connected");
  });

  upstreamSocket.on("close", () => {
    // console.log("Upstream WebSocket disconnected");
    reconnect(upstreamSocket, clientStream);
  });

  upstreamSocket.on("error", (error: Error) => {
    console.log("Upstream WebSocket error:", error);
  });

  upstreamSocket.on("message", async (data: WebSocket.Data) => {
    const message = data.toString();
    clientStream.send(message);
  });
}

function reconnect(upstreamSocket: WebSocket, clientStream: WebSocket) {
  console.log(`Retry connection...`);
  setTimeout(() => {
    if (upstreamSocket.readyState === WebSocket.CLOSED) {
      console.log("Trying to reconnect to upstream WebSocket...");
      upstreamSocket.removeAllListeners(); // イベントリスナーをクリア
      upstreamSocket = new WebSocket(upstreamUrl);
      connectUpstream(upstreamSocket, clientStream);
    } else {
      console.log("Upstream WebSocket is already connected or connecting");
    }
  }, 1000);
}

listen();

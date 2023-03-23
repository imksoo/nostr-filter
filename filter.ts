import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";

const listenPort = 8081; // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl = "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl = "ws://localhost:8080"; // 上流のWebSocketサーバのURL

const contentFilters = [/avive/i, /web3/, /lnbc/, /t\.me/]; // 正規表現パターンの配列

function listen() {
  console.log(`WebSocket server listening on ${listenPort}`);

  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url === "/") {
        // レスポンスヘッダーにCORSを許可するヘッダーを追加する
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
          if (err) {
            res.end("Please use a Nostr client to connect...\n");
          } else {
            res.end(data);
          }
        });
      } else {
        // Upgrade以外のリクエストを上流に転送する
        const proxyReq = http.request(
          upstreamHttpUrl,
          {
            method: req.method,
            headers: req.headers,
            path: req.url,
            agent: false,
          },
          (proxyRes) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        req.pipe(proxyReq);
      }
    }
  );
  const wss = new WebSocket.Server({ server });
  wss.on("connection", (clientStream: WebSocket, req: http.IncomingMessage) => {
    let upstreamSocket = new WebSocket(upstreamWsUrl);
    connectUpstream(upstreamSocket, clientStream);

    clientStream.on("message", async (data: WebSocket.Data) => {
      const message = data.toString();
      const event = JSON.parse(message);

      const ip =
        req.headers["x-real-ip"] ||
        req.headers["x-forwarded-for"] ||
        req.socket.remoteAddress;

      if (event[0] === "EVENT" && event[1].kind === 1) {
        let shouldRelay = true;
        for (const filter of contentFilters) {
          if (filter.test(event[1].content)) {
            // 正規表現パターンにマッチする場合はコンソールにログ出力
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
        console.log(
          `${shouldRelay ? "❔" : "🚫"} ${ip} : kind=${event[1].kind} pubkey=${
            event[1].pubkey
          } content=${JSON.stringify(event[1].content)}`
        );
      } else {
        if (upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(message);
        }
      }
    });

    clientStream.on("close", () => {
      // console.log("WebSocket disconnected");
    });

    clientStream.on("error", (error: Error) => {
      // console.log("WebSocket error:", error);
    });

    clientStream.pong = () => {
      clientStream.ping();
    };
  });
  server.listen(listenPort);
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
      upstreamSocket = new WebSocket(upstreamWsUrl);
      connectUpstream(upstreamSocket, clientStream);
    } else {
      console.log("Upstream WebSocket is already connected or connecting");
    }
  }, 1000);
}

listen();

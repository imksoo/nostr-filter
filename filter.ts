import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";

const listenPort = 8081; // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl = "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl = "ws://localhost:8080"; // 上流のWebSocketサーバのURL

const contentFilters = [/avive/i, /web3/, /lnbc/, /t\.me/, /nostr-vip\.top/]; // 正規表現パターンの配列

function listen() {
  console.log(`WebSocket server listening on ${listenPort}`);

  // HTTPサーバーの構成
  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Webブラウザーからアクセスされたら、index.htmlかデフォルトのコンテンツを返却する
      if (req.url === "/" && req.headers.accept !== "application/nostr+json") {
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
          if (err) {
            res.end("Please use a Nostr client to connect...\n");
          } else {
            res.end(data);
          }
        });
      } else {
        // Upgrade以外のリクエストとNIP-11を上流に転送する
        const proxyReq = http.request(
          upstreamHttpUrl,
          {
            method: req.method,
            headers: req.headers,
            path: req.url,
            agent: false,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        req.pipe(proxyReq);
      }
    }
  );
  // WebSocketサーバーの構成
  const wss = new WebSocket.Server({ server });
  wss.on(
    "connection",
    (downstreamSocket: WebSocket, req: http.IncomingMessage) => {
      console.log("Client WebSocket connected");

      let upstreamSocket = new WebSocket(upstreamWsUrl);
      connectUpstream(upstreamSocket, downstreamSocket);

      // クライアントからメッセージを受信したとき
      downstreamSocket.on("message", async (data: WebSocket.Data) => {
        const message = data.toString();
        const event = JSON.parse(message);

        // 接続元のクライアントIPを取得
        const ip =
          req.headers["x-real-ip"] ||
          req.headers["x-forwarded-for"] ||
          req.socket.remoteAddress;

        let shouldRelay = true;

        // kind1だけフィルタリングを行う
        if (event[0] === "EVENT" && event[1].kind === 1) {
          // 正規表現パターンとのマッチ判定
          for (const filter of contentFilters) {
            if (filter.test(event[1].content)) {
              shouldRelay = false;
              break;
            }
          }
          // イベント内容とフィルターの判定結果をコンソールにログ出力
          console.log(
            `${shouldRelay ? "❔" : "🚫"} ${ip} : kind=${
              event[1].kind
            } pubkey=${event[1].pubkey} content=${JSON.stringify(
              event[1].content
            )}`
          );
        }

        if (shouldRelay) {
          // 送信して良いと判断したメッセージは上流のWebSocketに送信
          if (upstreamSocket.readyState === WebSocket.OPEN) {
            upstreamSocket.send(message);
          } else {
            downstreamSocket.close();
          }
        }
      });

      downstreamSocket.on("close", () => {
        console.log("Client WebSocket disconnected by close event");
        upstreamSocket.close();
        console.log(" -> Upstream WebSocket disconnected");
      });

      downstreamSocket.on("error", (error: Error) => {
        console.log("Client WebSocket error:", error);
        upstreamSocket.close();
        downstreamSocket.close();
        console.log(" -> Upstream WebSocket disconnected");
      });

      downstreamSocket.pong = () => {
        downstreamSocket.ping();
      };
    }
  );
  // HTTP+WebSocketサーバーの起動
  server.listen(listenPort);
}

// 上流のリレーサーバーとの接続
function connectUpstream(upstreamSocket: WebSocket, clientStream: WebSocket) {
  upstreamSocket.on("open", () => {
    console.log(" -> Upstream WebSocket connected");
  });

  upstreamSocket.on("close", () => {
    console.log("Upstream WebSocket disconnected by close event");
    clientStream.close();
    console.log(" -> Client WebSocket disconnected");
  });

  upstreamSocket.on("error", (error: Error) => {
    console.log("Upstream WebSocket error:", error);
    clientStream.close();
    upstreamSocket.close();
    console.log(" -> Client WebSocket disconnected");
  });

  upstreamSocket.on("message", async (data: WebSocket.Data) => {
    const message = data.toString();
    clientStream.send(message);
  });
}

listen();

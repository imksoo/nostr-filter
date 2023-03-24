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
  wss.on("connection", (clientStream: WebSocket, req: http.IncomingMessage) => {
    console.log("Client WebSocket connected");

    let upstreamSocket = new WebSocket(upstreamWsUrl);
    connectUpstream(upstreamSocket, clientStream);

    // クライアントからメッセージを受信したとき
    clientStream.on("message", async (data: WebSocket.Data) => {
      const message = data.toString();
      const event = JSON.parse(message);

      // 接続元のクライアントIPを取得
      const ip =
        req.headers["x-real-ip"] ||
        req.headers["x-forwarded-for"] ||
        req.socket.remoteAddress;

      // kind1だけフィルタリングを行う
      if (event[0] === "EVENT" && event[1].kind === 1) {
        let shouldRelay = true;
        // 正規表現パターンとのマッチ判定
        for (const filter of contentFilters) {
          if (filter.test(event[1].content)) {
            shouldRelay = false;
            break;
          }
        }
        if (shouldRelay) {
          // 送信して良いと判断したメッセージは上流のWebSocketに送信
          sendMessageToUpstream(message);
        }
        // イベント内容とフィルターの判定結果をコンソールにログ出力
        console.log(
          `${shouldRelay ? "❔" : "🚫"} ${ip} : kind=${event[1].kind} pubkey=${
            event[1].pubkey
          } content=${JSON.stringify(event[1].content)}`
        );
      } else {
        // kind1以外はすべて上流のWebSocketに送信
        sendMessageToUpstream(message);
      }

      function sendMessageToUpstream(message: String) {
        switch (upstreamSocket.readyState) {
          default:
            reconnectUpstream(upstreamSocket, clientStream);
          case WebSocket.OPEN:
          case WebSocket.CONNECTING:
            waitForSocketReadyState(upstreamSocket, () => {
              upstreamSocket.send(message);
            });
            break;
        }
      }
    });

    clientStream.on("close", () => {
      console.log("Client WebSocket disconnected");
      closeUpstream(upstreamSocket);
      console.log("Upstream WebSocket disconnected");
    });

    clientStream.on("error", (error: Error) => {
      console.log("Client WebSocket error:", error);
      closeUpstream(upstreamSocket);
      console.log("Upstream WebSocket disconnected");
    });

    clientStream.pong = () => {
      clientStream.ping();
    };
  });
  // HTTP+WebSocketサーバーの起動
  server.listen(listenPort);
}

// 上流のリレーサーバーとの接続
function connectUpstream(
  upstreamSocket: WebSocket,
  clientStream: WebSocket,
  retryCount = 0
) {
  upstreamSocket.on("open", () => {
    console.log("Upstream WebSocket connected");
  });

  upstreamSocket.on("close", () => {
    console.log("Upstream WebSocket disconnected by close event");
    reconnectUpstream(upstreamSocket, clientStream, retryCount);
  });

  upstreamSocket.on("error", (error: Error) => {
    console.log("Upstream WebSocket error:", error);
    reconnectUpstream(upstreamSocket, clientStream, retryCount);
  });

  upstreamSocket.on("message", async (data: WebSocket.Data) => {
    const message = data.toString();
    clientStream.send(message);
  });
}

// 上流のリレーサーバーとの接続を切断する
function closeUpstream(upstreamSocket: WebSocket): void {
  upstreamSocket.removeAllListeners(); // イベントリスナーをクリア
  upstreamSocket.close();
}

// 上流のリレーサーバーとの再接続処理
function reconnectUpstream(
  upstreamSocket: WebSocket,
  clientStream: WebSocket,
  retryCount = 0
): void {
  // 再接続の間隔を0.3秒～60秒の間で指数関数的に増やす
  const timeout = Math.min(Math.pow(1.2, retryCount) * 300, 60 * 1000);
  console.log(`Retry connection...timeout=${timeout}`);

  setTimeout(() => {
    switch (upstreamSocket.readyState) {
      case WebSocket.CLOSED:
      case WebSocket.CLOSING:
        console.log("Trying to reconnect to upstream WebSocket...");
        closeUpstream(upstreamSocket);

        upstreamSocket = new WebSocket(upstreamWsUrl);
        connectUpstream(upstreamSocket, clientStream, retryCount + 1);
        break;
      default:
        console.log("Upstream WebSocket is already connected or connecting");
        break;
    }
  }, timeout);
}

function waitForSocketReadyState(socket: WebSocket, callback: Function) {
  if (socket.readyState === WebSocket.OPEN) {
    callback();
  } else {
    socket.addEventListener("open", () => {
      callback();
    });
  }
}

listen();

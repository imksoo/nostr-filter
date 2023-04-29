import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";

const listenPort = 8081; // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl = "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl = "ws://localhost:8080"; // 上流のWebSocketサーバのURL

const contentFilters = [
  /avive/i,
  /web3/i,
  /lnbc/,
  /t\.me/,
  /nostr-vip\.top/,
  // /running branle/, This word is used in nostr.watch
  /1C-0OTP4DRCWJY17XvOHO/,
  /\$GPT/,
]; // 正規表現パターンの配列

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
      let upstreamSocket = new WebSocket(upstreamWsUrl);
      connectUpstream(upstreamSocket, downstreamSocket);

      // クライアントとの接続が確立したら、アイドルタイムアウトを設定
      setIdleTimeout(downstreamSocket);

      // クライアントからメッセージを受信したとき
      downstreamSocket.on("message", async (data: WebSocket.Data) => {
        // メッセージを受信するたびに、タイムアウトをリセット
        resetIdleTimeout(downstreamSocket);

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
        upstreamSocket.close();
        clearIdleTimeout(downstreamSocket);
      });

      downstreamSocket.on("error", (error: Error) => {
        upstreamSocket.close();
        downstreamSocket.close();
        clearIdleTimeout(downstreamSocket);
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
    setIdleTimeout(upstreamSocket);
  });

  upstreamSocket.on("close", () => {
    clientStream.close();
    clearIdleTimeout(upstreamSocket);
  });

  upstreamSocket.on("error", (error: Error) => {
    clientStream.close();
    upstreamSocket.close();
    clearIdleTimeout(upstreamSocket);
  });

  upstreamSocket.on("message", async (data: WebSocket.Data) => {
    const message = data.toString();
    clientStream.send(message);
    resetIdleTimeout(upstreamSocket);
  });
}

listen();

// ソケットとタイムアウトIDを関連付けるためのMap
const idleTimeouts = new Map<WebSocket, NodeJS.Timeout>();

// ソケットとタイムアウト値を関連付けるためのMap
const timeoutValues = new Map<WebSocket, number>();

// タイムアウト値のデフォルト
const defaultTimeoutValue = 600 * 1000;

function setIdleTimeout(
  socket: WebSocket,
  timeout: number = defaultTimeoutValue
) {
  const timeoutId = setTimeout(() => {
    console.log("Idle timeout, closing connection");
    socket.close();
  }, timeout);

  idleTimeouts.set(socket, timeoutId);
  timeoutValues.set(socket, timeout);
}

function resetIdleTimeout(
  socket: WebSocket,
  defaultTimeout: number = defaultTimeoutValue
) {
  clearTimeout(idleTimeouts.get(socket));
  const timeout = timeoutValues.get(socket) ?? defaultTimeout;
  setIdleTimeout(socket, timeout); // タイムアウトを再利用、もしくはデフォルト値を使用
}

function clearIdleTimeout(socket: WebSocket) {
  clearTimeout(idleTimeouts.get(socket));
  idleTimeouts.delete(socket);
  timeoutValues.delete(socket);
}

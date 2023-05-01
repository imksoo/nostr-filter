import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";

const listenPort = process.env.LISTEN_PORT ?? 8081; // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl =
  process.env.UPSTREAM_HTTP_URL ?? "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl = process.env.UPSTREAM_WS_URL ?? "ws://localhost:8080"; // 上流のWebSocketサーバのURL

console.log(process.env);
console.log({ listenPort, upstreamHttpUrl, upstreamWsUrl });

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

// 全体の接続数
let connectionCount = 0;

// IPアドレスごとの接続数
const connectionCountsByIP = new Map<string, number>();

function logMemoryUsage() {
  setInterval(() => {
    const currentTime = new Date().toISOString();
    const memoryUsage = process.memoryUsage();
    const usedHeapSize = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
    const totalHeapSize = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
    const rssSize = (memoryUsage.rss / 1024 / 1024).toFixed(2);
    console.log(
      `logMemoryUsage : ${currentTime} Memory Usage: Used Heap: ${usedHeapSize} MB / Total Heap: ${totalHeapSize} MB / RSS: ${rssSize} MB / WebSocket connections: ${connectionCount}`
    );
  }, 10 * 60 * 1000); // 10分ごとに実行
}

logMemoryUsage();

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
    async (downstreamSocket: WebSocket, req: http.IncomingMessage) => {
      // 接続元のクライアントIPを取得
      const ip =
        (typeof req.headers["x-real-ip"] === "string"
          ? req.headers["x-real-ip"]
          : undefined) ||
        (typeof req.headers["x-forwarded-for"] === "string"
          ? req.headers["x-forwarded-for"].split(",")[0].trim()
          : undefined) ||
        (typeof req.socket.remoteAddress === "string"
          ? req.socket.remoteAddress
          : "unknown-ip-addr");

      // IPごとの接続数を取得・更新
      const connectionCountForIP = (connectionCountsByIP.get(ip) ?? 0) + 1;

      if (connectionCountForIP > 100) {
        console.log(`Too many connections from ${ip}.`);
        downstreamSocket.close(429, "Too many requests.");
        return;
      }

      connectionCountsByIP.set(ip, connectionCountForIP);

      let upstreamSocket = new WebSocket(upstreamWsUrl);
      connectUpstream(upstreamSocket, downstreamSocket);

      // クライアントとの接続が確立したら、アイドルタイムアウトを設定
      setIdleTimeout(downstreamSocket);

      // 接続が確立されるたびにカウントを増やす
      connectionCount++;

      // クライアントからメッセージを受信したとき
      downstreamSocket.on("message", async (data: WebSocket.Data) => {
        // メッセージを受信するたびに、タイムアウトをリセット
        resetIdleTimeout(downstreamSocket);

        const message = data.toString();
        const event = JSON.parse(message);

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
        connectionCount--; // 接続が閉じられるたびにカウントを減らす
        connectionCountsByIP.set(ip, connectionCountsByIP.get(ip) ?? 1 - 1);

        upstreamSocket.close();
        clearIdleTimeout(downstreamSocket);
      });

      downstreamSocket.on("error", (error: Error) => {
        connectionCount--; // エラーが発生するたびにカウントを減らす
        connectionCountsByIP.set(ip, connectionCountsByIP.get(ip) ?? 1 - 1);

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

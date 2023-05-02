import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import * as net from "net";
import { Mutex } from "async-mutex";

const listenPort: number = parseInt(process.env.LISTEN_PORT ?? "8081"); // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl: string =
  process.env.UPSTREAM_HTTP_URL ?? "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl: string =
  process.env.UPSTREAM_WS_URL ?? "ws://localhost:8080"; // 上流のWebSocketサーバのURL

console.log(JSON.stringify({ msg: "process.env", ...process.env }));
console.log(
  JSON.stringify({ msg: "configs", listenPort, upstreamHttpUrl, upstreamWsUrl })
);

// NostrのEvent contentsのフィルタリング用正規表現パターンの配列
const contentFilters = [
  /avive/i,
  /web3/i,
  /lnbc/,
  /t\.me/,
  /nostr-vip\.top/,
  // /running branle/, This word is used in nostr.watch
  /1C-0OTP4DRCWJY17XvOHO/,
  /\$GPT/,
];

// クライアントIPアドレスのCIDRフィルタ
const cidrRanges: string[] = [
  "43.205.189.224/32",
  "34.173.202.51/32",
  "129.205.113.128/25",
  "180.97.221.192/32",
  "62.197.152.37/32",
  "157.230.17.234/32",
];

// CIDRマッチ用のフィルタ関数
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);

  if (net.isIPv4(ip) && net.isIPv4(range)) {
    const ipNum = ip
      .split(".")
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
    const rangeNum = range
      .split(".")
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);

    return (ipNum & mask) === (rangeNum & mask);
  } else if (net.isIPv6(ip) && net.isIPv6(range)) {
    const ipNum = BigInt(`0x${ip.replace(/:/g, "")}`);
    const rangeNum = BigInt(`0x${range.replace(/:/g, "")}`);
    const mask6 = BigInt(
      `0x${"f".repeat(32 - parseInt(bits, 10))}${"0".repeat(
        parseInt(bits, 10)
      )}`
    );

    return (ipNum & mask6) === (rangeNum & mask6);
  }

  return false;
}

// 全体の接続数
let connectionCount = 0;
// IPアドレスごとの接続数
const connectionCountsByIP = new Map<string, number>();
// Mutexインスタンスを作成
const mutex = new Mutex();

function loggingMemoryUsage() {
  const currentTime = new Date().toISOString();
  const memoryUsage = process.memoryUsage();
  const usedHeapSize = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
  const totalHeapSize = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
  const rssSize = (memoryUsage.rss / 1024 / 1024).toFixed(2);
  console.log(
    JSON.stringify({
      msg: "memoryUsage",
      usedHeapSize,
      totalHeapSize,
      rssSize,
      connectionCount,
    })
  );
}

loggingMemoryUsage(); // 起動時のヒープ状態を出力
setInterval(() => {
  loggingMemoryUsage();
}, 10 * 60 * 1000); // ヒープ状態を10分ごとに実行

function listen() {
  console.log(JSON.stringify({ msg: "Started", listenPort }));

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

      // IPアドレスが指定したCIDR範囲内にあるかどうかを判断
      const isIpBlocked = cidrRanges.some((cidr) => ipMatchesCidr(ip, cidr));
      if (isIpBlocked) {
        // IPアドレスがCIDR範囲内にある場合、接続を拒否
        console.log(
          JSON.stringify({
            msg: "Blocked by CIDR filter",
            class: "🚫",
            ip,
          })
        );
        downstreamSocket.close(1008, "Forbidden");
        return;
      }

      // IPごとの接続数を取得・更新
      let connectionCountForIP = 0;
      await mutex.runExclusive(async () => {
        connectionCountForIP = (connectionCountsByIP.get(ip) ?? 0) + 1;
      });
      if (connectionCountForIP > 100) {
        console.log(
          JSON.stringify({
            msg: "Blocked by too many connections",
            class: "🚫",
            ip,
            connectionCountForIP,
          })
        );
        downstreamSocket.close(1008, "Too many requests.");
        return;
      } else {
        console.log(
          JSON.stringify({
            msg: "Connected",
            class: "❔",
            ip,
            connectionCountForIP,
          })
        );
        connectionCountsByIP.set(ip, connectionCountForIP);
      }

      // 上流となるリレーサーバーと接続
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
            JSON.stringify({
              msg: "EVENT",
              class: `${shouldRelay ? "❔" : "🚫"}`,
              ip,
              connectionCountForIP,
              kind: event[1].kind,
              pubkey: event[1].pubkey,
              content: JSON.stringify(event[1].content),
            })
          );
        } else if (event[0] === "REQ") {
          // REQイベントの内容をコンソールにログ出力
          console.log(
            JSON.stringify({
              msg: "REQ",
              class: `${shouldRelay ? "❔" : "🚫"}`,
              ip,
              connectionCountForIP,
              req: JSON.stringify(event[2]),
            })
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

      downstreamSocket.on("close", async () => {
        connectionCount--; // 接続が閉じられるたびにカウントを減らす
        await mutex.runExclusive(async () => {
          connectionCountsByIP.set(ip, (connectionCountsByIP.get(ip) ?? 1) - 1);
        });
        upstreamSocket.close();
        clearIdleTimeout(downstreamSocket);
      });

      downstreamSocket.on("error", async (error: Error) => {
        upstreamSocket.close();
      });

      downstreamSocket.pong = async () => {
        downstreamSocket.ping();
      };
    }
  );
  // HTTP+WebSocketサーバーの起動
  server.listen(listenPort);
}

// 上流のリレーサーバーとの接続
function connectUpstream(upstreamSocket: WebSocket, clientStream: WebSocket) {
  upstreamSocket.on("open", async () => {
    setIdleTimeout(upstreamSocket);
  });

  upstreamSocket.on("close", async () => {
    clientStream.close();
    clearIdleTimeout(upstreamSocket);
  });

  upstreamSocket.on("error", async (error: Error) => {
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

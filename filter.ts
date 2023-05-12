import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import * as net from "net";
import { Mutex } from "async-mutex";
import { v4 as uuidv4 } from "uuid";

class WebSocketWithID extends WebSocket {
  id: string;

  constructor(address: string, options?: WebSocket.ClientOptions) {
    super(address, options);
    this.id = uuidv4();
  }
}

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
const contentFilters: RegExp[] = [
];

// ブロックするユーザーの公開鍵の配列
const blockedPubkeys: string[] = [];

// クライアントIPアドレスのCIDRフィルタ
const cidrRanges: string[] = [
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
const connectionCountMutex = new Mutex();

// サブスクリプションIDに紐付くIPアドレス
const subscriptionIdAndIPAddress = new Map<string, string>();
const subscriptionIdAndPortNumber = new Map<string, number>();
// サブスクリプションIDごとの転送量
const transferredSizePerSubscriptionId = new Map<string, number>();
// Mutexインスタンスを作成
const subscriptionSizeMutex = new Mutex();

function loggingMemoryUsage(): void {
  const currentTime = new Date().toISOString();
  const memoryUsage = process.memoryUsage();
  const usedHeapSize = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  const totalHeapSize = Math.round(memoryUsage.heapTotal / 1024 / 1024);
  const rssSize = Math.round(memoryUsage.rss / 1024 / 1024);
  console.log(
    JSON.stringify({
      msg: "memoryUsage",
      currentTime,
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
}, 1 * 60 * 1000); // ヒープ状態を1分ごとに実行

function listen(): void {
  console.log(JSON.stringify({ msg: "Started", listenPort }));

  // HTTPサーバーの構成
  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Webブラウザーからアクセスされたら、index.htmlかデフォルトのコンテンツを返却する
      if (req.url === "/" && req.headers.accept !== "application/nostr+json") {
	res.writeHead(301, { "Location": "/index.html" } );
	res.end();
        /* res.writeHead(200, { "Content-Type": "text/html" });
        fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
          if (err) {
            res.end("Please use a Nostr client to connect...\n");
          } else {
            res.end(data);
          }
        }); */
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
    async (downstreamSocket: WebSocketWithID, req: http.IncomingMessage) => {
      // ソケットごとにユニークなIDを付与
      const socketId = uuidv4();
      downstreamSocket.id = socketId;

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

      // 接続元のクライアントIPを取得
      const port =
        typeof req.headers["x-real-port"] === "string"
          ? parseInt(req.headers["x-real-port"])
          : 0;

      // IPアドレスが指定したCIDR範囲内にあるかどうかを判断
      const isIpBlocked = cidrRanges.some((cidr) => ipMatchesCidr(ip, cidr));
      if (isIpBlocked) {
        const because = "Blocked by CIDR filter";
        // IPアドレスがCIDR範囲内にある場合、接続を拒否
        console.log(
          JSON.stringify({
            msg: "CONNECTING BLOCKED",
            because,
            ip,
            port,
            socketId,
          })
        );
        const blockedMessage = JSON.stringify([
          "NOTICE",
          `blocked: ${because}`,
        ]);
        console.log(
          JSON.stringify({
            msg: "BLOCKED NOTICE",
            ip,
            port,
            socketId,
            because,
            blockedMessage,
          })
        );
        downstreamSocket.send(blockedMessage);
        downstreamSocket.close(1008, "Forbidden");
        return;
      }

      // IPごとの接続数を取得・更新
      let connectionCountForIP = 0;
      await connectionCountMutex.runExclusive(async () => {
        connectionCountForIP = (connectionCountsByIP.get(ip) ?? 0) + 1;
      });
      if (connectionCountForIP > 100) {
        const because = "Blocked by too many connections";
        console.log(
          JSON.stringify({
            msg: "CONNECTING BLOCKED",
            because,
            ip,
            port,
            socketId,
            connectionCountForIP,
          })
        );
        const blockedMessage = JSON.stringify([
          "NOTICE",
          `blocked: ${because}`,
        ]);
        console.log(
          JSON.stringify({
            msg: "BLOCKED NOTICE",
            ip,
            port,
            socketId,
            connectionCountForIP,
            because,
            blockedMessage,
          })
        );
        downstreamSocket.send(blockedMessage);
        downstreamSocket.close(1008, "Too many requests.");
        return;
      } else {
        console.log(
          JSON.stringify({
            msg: "CONNECTED",
            ip,
            port,
            socketId,
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
        resetIdleTimeout(upstreamSocket);

        const message = data.toString();
        const event = JSON.parse(message);

        let shouldRelay = true;
        let because = "";
        let isMessageEdited = false;
        // kind1だけフィルタリングを行う
        if (event[0] === "EVENT" && event[1].kind === 1) {
          // 正規表現パターンとのマッチ判定
          for (const filter of contentFilters) {
            if (filter.test(event[1].content)) {
              shouldRelay = false;
              because = "Blocked event by content filter";
              break;
            }
          }
          // ブロックする公開鍵のリストとのマッチ判定
          for (const block of blockedPubkeys) {
            if (event[1].pubkey === block) {
              shouldRelay = false;
              because = "Blocked event by pubkey";
              break;
            }
          }

          // イベント内容とフィルターの判定結果をコンソールにログ出力
          if (shouldRelay) {
            console.log(
              JSON.stringify({
                msg: "EVENT",
                ip,
                port,
                socketId,
                connectionCountForIP,
                event: event[1],
              })
            );
          } else {
            console.log(
              JSON.stringify({
                msg: "EVENT BLOCKED",
                because,
                ip,
                port,
                socketId,
                connectionCountForIP,
                event: event[1],
              })
            );
          }
        } else if (event[0] === "REQ") {
          const subscriptionId = event[1];
          const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
          subscriptionIdAndIPAddress.set(socketAndSubscriptionId, ip);
          subscriptionIdAndPortNumber.set(socketAndSubscriptionId, port);
          // REQイベントの内容をコンソールにログ出力
          console.log(
            JSON.stringify({
              msg: "REQ",
              ip,
              port,
              socketId,
              connectionCountForIP,
              subscriptionId,
              req: event[2],
            })
          );

          if (!event[2].limit || event[2].limit > 500) {
            event[2].limit = 500;
            isMessageEdited = true;

            /*
            because = "Invalid or excessive value for limit property.";
            const warningMessage = JSON.stringify([
              "NOTICE",
              `warning: ${because}`,
            ]);
            console.log(
              JSON.stringify({
                msg: "WARNING NOTICE",
                ip,
                port,
                socketId,
                connectionCountForIP,
                warningMessage,
                event,
              })
            );
            downstreamSocket.send(warningMessage);
            */
          }
        } else if (event[0] === "CLOSE") {
          const subscriptionId = event[1];
          const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
          subscriptionIdAndIPAddress.set(
            socketAndSubscriptionId,
            ip + " CLOSED"
          );
          subscriptionIdAndPortNumber.set(socketAndSubscriptionId, -port);
          // REQイベントの内容をコンソールにログ出力
          console.log(
            JSON.stringify({
              msg: "CLOSE SUBSCRIPTION",
              ip,
              port,
              socketId,
              connectionCountForIP,
              subscriptionId,
              req: event[2],
            })
          );
        }

        if (shouldRelay) {
          // 送信して良いと判断したメッセージは上流のWebSocketに送信
          if (upstreamSocket.readyState === WebSocket.OPEN) {
            if (isMessageEdited) {
              const messageEdited = JSON.stringify(event);
              upstreamSocket.send(messageEdited);
            } else {
              upstreamSocket.send(message);
            }
          } else {
            downstreamSocket.close();
          }
        } else {
          // ブロック対象のメッセージを送ってきたクライアントには警告メッセージを返却
          if (event[0] === "EVENT") {
            const blockedMessage = JSON.stringify([
              "OK",
              event[1].id,
              false,
              `blocked: ${because}`,
            ]);
            console.log(
              JSON.stringify({
                msg: "BLOCKED EVENT",
                ip,
                port,
                socketId,
                connectionCountForIP,
                blockedMessage,
                event,
              })
            );
            downstreamSocket.send(blockedMessage);
          } else {
            const blockedMessage = JSON.stringify([
              "NOTICE",
              `blocked: ${because}`,
            ]);
            console.log(
              JSON.stringify({
                msg: "BLOCKED NOTICE",
                ip,
                port,
                socketId,
                connectionCountForIP,
                blockedMessage,
                event,
              })
            );
            downstreamSocket.send(blockedMessage);
          }
          downstreamSocket.close();
        }
      });

      downstreamSocket.on("close", async () => {
        connectionCount--; // 接続が閉じられるたびにカウントを減らす

        let connectionCountForIP = 1;
        await connectionCountMutex.runExclusive(async () => {
          connectionCountForIP = connectionCountsByIP.get(ip) ?? 1;
          connectionCountsByIP.set(ip, connectionCountForIP - 1);
        });
        console.log(
          JSON.stringify({
            msg: "DISCONNECTED",
            ip,
            port,
            socketId,
            connectionCountForIP,
          })
        );
        upstreamSocket.close();
        clearIdleTimeout(downstreamSocket);
      });

      downstreamSocket.on("error", async (error: Error) => {
        console.log(
          JSON.stringify({
            msg: "DOWNSTREAM ERROR",
            ip,
            port,
            socketId,
            connectionCountForIP,
            error,
          })
        );
        downstreamSocket.close();
        upstreamSocket.close();
      });

      downstreamSocket.pong = async () => {
        console.log(
          JSON.stringify({
            msg: "PONG",
            ip,
            port,
            socketId,
            connectionCountForIP,
          })
        );
        downstreamSocket.ping();
      };
    }
  );
  // HTTP+WebSocketサーバーの起動
  server.listen(listenPort);
}

// 上流のリレーサーバーとの接続
function connectUpstream(
  upstreamSocket: WebSocket,
  downstreamSocket: WebSocketWithID
): void {
  upstreamSocket.on("open", async () => {
    const socketId = downstreamSocket.id;
    console.log(
      JSON.stringify({
        msg: "UPSTREAM CONNECTED",
        socketId,
      })
    );
    setIdleTimeout(upstreamSocket);
  });

  upstreamSocket.on("close", async () => {
    const socketId = downstreamSocket.id;
    console.log(
      JSON.stringify({
        msg: "UPSTREAM DISCONNECTED",
        socketId,
      })
    );
    downstreamSocket.close();
    clearIdleTimeout(upstreamSocket);
  });

  upstreamSocket.on("error", async (error: Error) => {
    const socketId = downstreamSocket.id;
    console.log(
      JSON.stringify({
        msg: "UPSTREAM ERROR",
        socketId,
        error,
      })
    );
    downstreamSocket.close();
    upstreamSocket.close();
  });

  upstreamSocket.on("message", async (data: WebSocket.Data) => {
    const message = data.toString();
    const event = JSON.parse(message);
    resetIdleTimeout(downstreamSocket);
    resetIdleTimeout(upstreamSocket);

    let shouldRelay = true;
    let because = "";
    if (event[0] === "EVENT" && event[2].kind === 1) {
      // 正規表現パターンとのマッチ判定
      for (const filter of contentFilters) {
        if (filter.test(event[2].content)) {
          shouldRelay = false;
          because = "Blocked event by content filter";
          break;
        }
      }
      // ブロックする公開鍵のリストとのマッチ判定
      for (const block of blockedPubkeys) {
        if (event[2].pubkey === block) {
          shouldRelay = false;
          because = "Blocked event by pubkey";
          break;
        }
      }
    }
    const result = JSON.parse(message);
    const socketId = downstreamSocket.id;
    const resultType = result[0];
    const subscriptionId = result[1];
    const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
    const ip =
      subscriptionIdAndIPAddress.get(socketAndSubscriptionId) ??
      "???.???.???.???";
    const port = subscriptionIdAndPortNumber.get(socketAndSubscriptionId) ?? -1;
    let subscriptionSize;
    await subscriptionSizeMutex.runExclusive(async () => {
      subscriptionSize =
        (transferredSizePerSubscriptionId.get(socketAndSubscriptionId) ?? 0) +
        message.length;
      transferredSizePerSubscriptionId.set(
        socketAndSubscriptionId,
        subscriptionSize
      );
    });
    console.log(
      JSON.stringify({
        msg: "SUBSCRIBE",
        ip,
        port,
        resultType,
        socketId,
        subscriptionId,
        subscriptionSize,
      })
    );
    if (shouldRelay) {
      downstreamSocket.send(message);
    } else {
      console.log(
        JSON.stringify({
          msg: "EVENT MUTED",
          because,
          ip,
          port,
          socketId,
          event,
        })
      );
    }
  });
}

listen();

// ソケットとタイムアウトIDを関連付けるためのMap
const idleTimeouts = new Map<WebSocket, NodeJS.Timeout>();

// ソケットとタイムアウト値を関連付けるためのMap
const timeoutValues = new Map<WebSocket, number>();

// タイムアウト値のデフォルト
const defaultTimeoutValue = 10 * 60 * 1000;

function setIdleTimeout(
  socket: WebSocket,
  timeout: number = defaultTimeoutValue
): void {
  const timeoutId = setTimeout(() => {
    socket.close();
  }, timeout);

  idleTimeouts.set(socket, timeoutId);
  timeoutValues.set(socket, timeout);
}

function resetIdleTimeout(
  socket: WebSocket,
  defaultTimeout: number = defaultTimeoutValue
): void {
  clearTimeout(idleTimeouts.get(socket));
  const timeout = timeoutValues.get(socket) ?? defaultTimeout;
  setIdleTimeout(socket, timeout); // タイムアウトを再利用、もしくはデフォルト値を使用
}

function clearIdleTimeout(socket: WebSocket): void {
  clearTimeout(idleTimeouts.get(socket));
  idleTimeouts.delete(socket);
  timeoutValues.delete(socket);
}

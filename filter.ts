import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import url from "url";
import * as net from "net";
import { Mutex } from "async-mutex";
import { v4 as uuidv4 } from "uuid";
import * as mime from "mime-types";
import dotenv from "dotenv";
import "websocket-polyfill";
import {
  generatePrivateKey,
  getEventHash,
  getPublicKey,
  getSignature,
  nip44,
  SimplePool,
  SubscriptionOptions,
  validateEvent,
  verifySignature,
} from "nostr-tools";
import { eventKind, NostrEventExt, NostrFetcher } from "nostr-fetch";
import { simplePoolAdapter } from "@nostr-fetch/adapter-nostr-tools";
import pLimit from "p-limit";
import { LRUCache } from "lru-cache";
import { exit } from "process";
import { setInterval } from "timers";
import {
  extractHashtags,
  hasContentWarning,
  hasNsfwHashtag,
  isActivityPubUser,
} from "./nostr-util";

dotenv.config();

const listenPort: number = parseInt(process.env.LISTEN_PORT ?? "8081"); // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl: string =
  process.env.UPSTREAM_HTTP_URL ?? "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl: string =
  process.env.UPSTREAM_WS_URL ?? "ws://localhost:8080"; // 上流のWebSocketサーバのURL
const NOSTR_MONITORING_BOT_PUBLIC_KEY: string =
  process.env.NOSTR_MONITORING_BOT_PUBLIC_KEY ?? "";
const CLASSIFICATION_EVENT_KIND = 9978;

const pool = new SimplePool();
// const fetcher = NostrFetcher.init();
const fetcher = NostrFetcher.withCustomPool(simplePoolAdapter(pool));
const requestLimiter = pLimit(20);
const nHoursAgoInUnixTime = (hrs: number): number =>
  Math.floor((Date.now() - hrs * 60 * 60 * 1000) / 1000);

const cache = new LRUCache(
  {
    max: 100000,
    // how long to live in ms
    ttl: 24 * 60 * 60 * 1000,
  },
);

// 書き込み用の上流リレーとの接続(あらかじめ接続しておいて、WS接続直後のイベントでも取りこぼしを防ぐため)
let upstreamWriteSocket = new WebSocket(upstreamWsUrl);

console.log(JSON.stringify({ msg: "process.env", ...process.env }));
console.log(
  JSON.stringify({
    msg: "configs",
    listenPort,
    upstreamHttpUrl,
    upstreamWsUrl,
  }),
);

// NostrのEvent contentsのフィルタリング用正規表現パターンの配列
const contentFilters: RegExp[] = [
  /avive/i,
  /web3/i,
  /lnbc/,
  /t\.me/,
  /nostr-vip\.top/,
  /1C-0OTP4DRCWJY17XvOHO/,
  /\$GPT/,
  /Claim your free/,
  /Claim Free/i,
  /shop\.55uu\.wang/,
  /dosoos/i,
  /coderba/i,
  /人工智能/,
  /dapp/,
  /motherfuckers/,
  /shitspaming/,
  /telegra\.ph/,
  /幼女爱好/,
];

// ブロックするユーザーの公開鍵の配列
const blockedPubkeys: string[] =
  (typeof process.env.BLOCKED_PUBKEYS !== "undefined")
    ? process.env.BLOCKED_PUBKEYS.split(",").map((pubkey) => pubkey.trim())
    : [];
// Allow only whitelisted pubkey to write events
const whitelistedPubkeys: string[] =
  (typeof process.env.WHITELISTED_PUBKEYS !== "undefined" && process.env.WHITELISTED_PUBKEYS !== "")
    ? process.env.WHITELISTED_PUBKEYS.split(",").map((pubkey) => pubkey.trim())
    : [];
// Filter proxy events
const filterProxyEvents = (process.env.FILTER_PROXY_EVENTS === "true")

// クライアントIPアドレスのCIDRフィルタ
const cidrRanges: string[] = [
  "43.205.189.224/32",
  "34.173.202.51/32",
  "129.205.113.128/25",
  "180.97.221.192/32",
  "62.197.152.37/32",
  "157.230.17.234/32",
  "185.25.224.220/32",
  "35.231.153.85/32",
  "103.135.251.248/32",
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
      `0x${"f".repeat(32 - parseInt(bits, 10))}${
        "0".repeat(
          parseInt(bits, 10),
        )
      }`,
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
    }),
  );
}

loggingMemoryUsage(); // 起動時のヒープ状態を出力
setInterval(() => {
  loggingMemoryUsage();
}, 1 * 60 * 1000); // ヒープ状態を1分ごとに実行

let relayPool;

async function regularEventFetcherWarmup() {
  let subRegularEventFetcher = pool.sub(
    [upstreamWsUrl],
    [
      {
        kinds: [eventKind.text],
        limit: 500,
      },
    ],
    {
      id: "regularEventFetcher-1",
    },
  );

  subRegularEventFetcher.on("eose", () => {
    subRegularEventFetcher.unsub();
    // subNsfwClassificationDataEose = true;
  });
  subRegularEventFetcher.on("event", (event) => {
    // Only process after eose event
    // return
  });
}

async function fetchSubscribeClassificationDataHistory(
  hoursAgoToCheck: number = 24,
) {
  const classificationData = await fetcher.fetchAllEvents(
    [upstreamWsUrl],
    /* filter */
    {
      kinds: [CLASSIFICATION_EVENT_KIND],
      "authors": [NOSTR_MONITORING_BOT_PUBLIC_KEY],
      "#d": ["nostr-nsfw-classification"],
      // "#e": subEventsId,
    },
    /* time range filter */
    {
      since: nHoursAgoInUnixTime(hoursAgoToCheck),
      until: nHoursAgoInUnixTime(0),
    },
    /* fetch options (optional) */
    { sort: false, skipVerification: true },
  ) ?? [];

  for (const classification of classificationData) {
    const eventTag = classification.tags.filter((tag) => tag[0] === "e");
    if (eventTag.length === 0) continue;
    const eventId = eventTag[0][1];
    if (cache.has(eventId)) continue;
    cache.set(eventId, JSON.parse(classification.content));
  }

  console.log(classificationData[0]);
  console.log(classificationData[classificationData.length - 1]);
  console.log(classificationData.length);

  let subNsfwClassificationData = pool.sub(
    [upstreamWsUrl],
    [
      {
        kinds: [CLASSIFICATION_EVENT_KIND],
        "authors": [NOSTR_MONITORING_BOT_PUBLIC_KEY],
        "#d": ["nostr-nsfw-classification"],
      },
    ],
    {
      id: "subNsfwClassification",
    },
  );
  let subNsfwClassificationDataEose = false;

  subNsfwClassificationData.on("eose", () => {
    // sub.unsub()
    subNsfwClassificationDataEose = true;
  });
  subNsfwClassificationData.on("event", (event) => {
    // Only process after eose event
    // if (!subNsfwClassificationDataEose) return;
    if (event) {
      try {
        if (!cache.has(event.id)) {
          const nsfwClassificationData = JSON.parse(
            event.content,
          );
          cache.set(event.id, nsfwClassificationData);
        }
      } catch (error) {
        console.error(error);
      }
    }
  });
}

async function listen(): Promise<void> {
  const hoursAgoToCheck = 24 * 1;

  // throw new Error("stop");
  // exit();
  await fetchSubscribeClassificationDataHistory(hoursAgoToCheck);

  // Regular event fetcher warmup
  setInterval(() => regularEventFetcherWarmup, 60 * 1000);

  console.log(JSON.stringify({ msg: "Started", listenPort }));

  // HTTPサーバーの構成
  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url === "/" && req.headers.accept !== "application/nostr+json") {
        // リレー自身のURLに通常のWebブラウザーからアクセスされたら、とりあえずindex.htmlへリダイレクトする
        console.log(JSON.stringify({ msg: "HTTP GET", url: req.url }));
        res.writeHead(301, { Location: "/index.html" });
        res.end();
      } else if (req.url && req.headers.accept !== "application/nostr+json") {
        // staticディレクトリ配下の静的ファイルを返却する
        console.log(JSON.stringify({ msg: "HTTP GET", url: req.url }));
        const pathname = url.parse(req.url).pathname || "";
        const filePath = path.join(__dirname, "/static/", pathname);
        const contentType = mime.contentType(path.extname(filePath)) ||
          "application/octet-stream";
        fs.readFile(filePath, (err, data) => {
          if (err) {
            console.log(
              JSON.stringify({ msg: "HTTP RESOURCE NOT FOUND", url: req.url }),
            );
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("Please use a Nostr client to connect...\n");
          } else {
            console.log(
              JSON.stringify({
                msg: "HTTP RESPONSE",
                url: req.url,
                contentType,
                length: data.length,
              }),
            );
            res.writeHead(200, { "Content-Type": contentType });
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
          },
        );
        req.pipe(proxyReq);
      }
    },
  );
  // WebSocketサーバーの構成
  const wss = new WebSocket.Server({ server });
  wss.on(
    "connection",
    async (downstreamSocket: WebSocket, req: http.IncomingMessage) => {
      // サブスクリプションIDに紐付くIPアドレス
      const subscriptionIdAndIPAddress = new Map<string, string>();
      const subscriptionIdAndPortNumber = new Map<string, number>();
      // サブスクリプションIDごとの転送量
      const transferredSizePerSubscriptionId = new Map<string, number>();
      // Mutexインスタンスを作成
      const subscriptionSizeMutex = new Mutex();

      // ソケットごとにユニークなIDを付与
      const socketId = uuidv4();

      // 上流となるリレーサーバーと接続
      let upstreamSocket = new WebSocket(upstreamWsUrl);
      connectUpstream(upstreamSocket, downstreamSocket);

      // クライアントとの接続が確立したら、アイドルタイムアウトを設定
      setIdleTimeout(downstreamSocket);

      // 接続が確立されるたびにカウントを増やす
      connectionCount++;

      const reqUrl = new URL(req.url ?? "/", `http://${req.headers["host"]}`);
      const searchParams = reqUrl.searchParams;

      // 接続元のクライアントIPを取得
      const ip =
        (typeof req.headers["cloudfront-viewer-address"] === "string"
          ? req.headers["cloudfront-viewer-address"]
            .split(":")
            .slice(0, -1)
            .join(":")
          : undefined) ||
        (typeof req.headers["x-real-ip"] === "string"
          ? req.headers["x-real-ip"]
          : undefined) ||
        (typeof req.headers["x-forwarded-for"] === "string"
          ? req.headers["x-forwarded-for"].split(",")[0].trim()
          : undefined) ||
        (typeof req.socket.remoteAddress === "string"
          ? req.socket.remoteAddress
          : "unknown-ip-addr");

      // 接続元のクライアントPortを取得
      const port =
        (typeof req.headers["cloudfront-viewer-address"] === "string"
          ? parseInt(
            req.headers["cloudfront-viewer-address"].split(":").slice(-1)[0],
          )
          : undefined) ||
        (typeof req.headers["x-real-port"] === "string"
          ? parseInt(req.headers["x-real-port"])
          : 0);

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
          }),
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
          }),
        );
        upstreamSocket.close();
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
          }),
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
          }),
        );
        upstreamSocket.close();
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
            headers: req.headers
          }),
        );
        connectionCountsByIP.set(ip, connectionCountForIP);
      }

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
        if (event[0] === "EVENT") {
          const subscriptionId = event[1].id;
          const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
          subscriptionIdAndIPAddress.set(socketAndSubscriptionId, ip);
          subscriptionIdAndPortNumber.set(socketAndSubscriptionId, port);

          if (event[1].kind === 1) {
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

            // Proxyイベントをフィルターする
            if (filterProxyEvents) {
              for (const tag of event[1].tags) {
                if (tag[0] === "proxy") {
                  shouldRelay = false;
                  because = "Blocked event by proxied event";
                  break;
                }
              }
            }
          }

          // Allow write any event only for whitelisted pubkeys in downstream messages
          for (const allowed of whitelistedPubkeys) {
            if (event[1].pubkey !== allowed) {
              shouldRelay = false;
              because = "Only whitelisted pubkey can write events";
              // break;
            } else {
              shouldRelay = true;
              because = "";
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
              }),
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
              }),
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
            }),
          );

          if (event[2].limit && event[2].limit > 2000) {
            event[2].limit = 2000;
            isMessageEdited = true;
          }
        } else if (event[0] === "CLOSE") {
          const subscriptionId = event[1];
          const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
          subscriptionIdAndIPAddress.set(
            socketAndSubscriptionId,
            ip + " CLOSED",
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
              subscriptionSize: transferredSizePerSubscriptionId.get(
                socketAndSubscriptionId,
              ),
            }),
          );
        } else {
          console.log(
            JSON.stringify({
              msg: "UNKNOWN",
              ip,
              port,
              socketId,
              connectionCountForIP,
              message: event,
            }),
          );
        }

        if (shouldRelay) {
          // 送信が成功したかどうかを確認するフラグ
          let isMessageSent = false;
          let isWebSocketClosed = false;
          // リトライ回数をカウントする変数
          let retryCount = 0;

          function sendMessage(): boolean {
            let msg = message;
            if (isMessageEdited) {
              msg = JSON.stringify(event);
            }

            // 書き込んで良いイベントはあらかじめ接続済みのソケットに送信する
            if (event[0] === "EVENT") {
              upstreamWriteSocket.send(msg);
            }

            // REQやEVENTを個別のソケットでやり取りする(OKメッセージの受信のため)
            if (upstreamSocket.readyState === WebSocket.OPEN) {
              upstreamSocket.send(msg);

              // メッセージが送信されたのでフラグをtrueにする
              isMessageSent = true;
              if (retryCount > 0) {
                console.log(
                  JSON.stringify({
                    msg: "RETRY SUCCEEDED",
                    ip,
                    port,
                    socketId,
                    connectionCountForIP,
                    retryCount,
                  }),
                );
              }
              return false;
            } else if (upstreamSocket.readyState === WebSocket.CONNECTING) {
              // リトライ回数をカウント
              retryCount++;
              return true;
            } else {
              isWebSocketClosed = true;

              upstreamSocket.close();
              downstreamSocket.close();

              console.log(
                JSON.stringify({
                  msg: "RETRY DISCONTINUED",
                  ip,
                  port,
                  socketId,
                  connectionCountForIP,
                  retryCount,
                }),
              );
              return false;
            }
          }

          // 送信して良いと判断したメッセージは上流のWebSocketに送信
          if (sendMessage()) {
            let intervalId = setInterval(() => {
              if (!sendMessage()) {
                clearInterval(intervalId);
              }
            }, 0.5 * 1000);

            // WebSocketが接続されない場合、もしくは5秒経ってもメッセージが送信されない場合は下流のWebSocketを閉じる
            setTimeout(() => {
              if (!isMessageSent && !isWebSocketClosed) {
                clearInterval(intervalId);

                upstreamSocket.close();
                downstreamSocket.close();

                console.log(
                  JSON.stringify({
                    msg: "RETRY TIMEOUT",
                    ip,
                    port,
                    socketId,
                    connectionCountForIP,
                    retryCount,
                  }),
                );
              }
            }, 30 * 1000);
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
              }),
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
              }),
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
          }),
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
          }),
        );
        downstreamSocket.close();
        upstreamSocket.close();
      });

      // 上流のリレーサーバーとの接続
      function connectUpstream(
        upstreamSocket: WebSocket,
        downstreamSocket: WebSocket,
      ): void {
        upstreamSocket.on("open", async () => {
          console.log(
            JSON.stringify({
              msg: "UPSTREAM CONNECTED",
              socketId,
            }),
          );
          setIdleTimeout(upstreamSocket);
        });

        upstreamSocket.on("close", async () => {
          console.log(
            JSON.stringify({
              msg: "UPSTREAM DISCONNECTED",
              socketId,
            }),
          );
          downstreamSocket.close();
          clearIdleTimeout(upstreamSocket);
        });

        upstreamSocket.on("error", async (error: Error) => {
          console.log(
            JSON.stringify({
              msg: "UPSTREAM ERROR",
              socketId,
              error,
            }),
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

            const eventId = event[2].id;

            // My Classification Filter
            let cachedClassification;
            if (cache.has(eventId)) {
              cachedClassification = cache.get(eventId);
            } else {
              // Fetch classification data
              // const classificationRawData = await fetcher.fetchLastEvent(
              //   [upstreamWsUrl],
              //   /* filter */
              //   {
              //     kinds: [CLASSIFICATION_EVENT_KIND],
              //     "authors": [NOSTR_MONITORING_BOT_PUBLIC_KEY],
              //     "#e": [eventId],
              //     "#d": ["nostr-nsfw-classification"],
              //   },
              // );

              // if (classificationRawData) {
              //   cachedClassification = JSON.parse(
              //     classificationRawData.content,
              //   );
              //   cache.set(eventId, cachedClassification);
              // }
            }

            let isNsfw = false;
            let filterContentMode = searchParams.get("content") ?? "sfw";
            let validFilterContentMode = ["all", "sfw", "nsfw"];
            let nsfwConfidenceThresold = parseInt(
              searchParams.get("nsfw_confidence") ?? "75",
            );
            nsfwConfidenceThresold = Number.isNaN(nsfwConfidenceThresold) ||
                nsfwConfidenceThresold < 0 || nsfwConfidenceThresold > 100
              ? 75 / 100
              : nsfwConfidenceThresold / 100;
            let filterUserMode = searchParams.get("user") ?? "all";
            let validFilterUserMode = ["all", "nostr", "activitypub"];
            const contentWarningExist = hasContentWarning(event[2].tags ?? []);
            const nsfwHashtagExist = hasNsfwHashtag(
              extractHashtags(event[2].tags ?? []),
            );

            // Check classification results
            if (cachedClassification) {
              const nsfwRulesFilter = function (
                classifications: any,
                nsfwConfidenceThresold: number = 0.75,
              ): boolean {
                // Doesn't have classifications data since it doesn't have image url
                if (!classifications) return false;

                // Check if any image url classification is nsfw
                let result = false;
                for (const classification of classifications) {
                  const nsfw_probabilty = 1 -
                    parseFloat(classification.data.neutral);
                  if (nsfw_probabilty >= nsfwConfidenceThresold) {
                    result = true;
                    break;
                  }
                }
                return result;
              };

              isNsfw = nsfwRulesFilter(
                cachedClassification,
                nsfwConfidenceThresold,
              );
            }

            const isSensitiveContent = isNsfw || contentWarningExist ||
              nsfwHashtagExist;
            switch (filterContentMode) {
              case "sfw":
                shouldRelay = !isSensitiveContent;
                if (!shouldRelay) because = "Non-NSFW only filtered";
                break;
              case "nsfw":
                shouldRelay = isSensitiveContent;
                if (!shouldRelay) because = "NSFW only filtered";
                break;
              default:
                shouldRelay = true;
                because = "";
                break;
            }

            // console.log("isSensitiveContent", isSensitiveContent);

            let activityPubUser = isActivityPubUser(event[2].tags ?? []);

            // console.log("activityPubUser", activityPubUser);
            switch (filterUserMode) {
              case "nostr":
                if (!shouldRelay) break;
                shouldRelay = !activityPubUser;
                if (!shouldRelay) because = "Nostr native user only filtered";
                break;
              case "activitypub":
                if (!shouldRelay) break;
                shouldRelay = activityPubUser;
                if (!shouldRelay) because = "activitypub user only filtered";
                break;
              default:
                if (!shouldRelay) break;
                shouldRelay = true;
                because = "";
                break;
            }
          }
          const result = JSON.parse(message);
          const resultType = result[0];
          if (resultType === "OK") {
            console.log(
              JSON.stringify({
                msg: "EVENT WRITE",
                ip,
                port,
                resultType,
                socketId,
                eventId: result[1],
              }),
            );
          } else if (resultType === "NOTICE") {
            console.log(
              JSON.stringify({
                msg: "NOTICE",
                ip,
                port,
                resultType,
                socketId,
                message: result,
              }),
            );
          } else {
            const subscriptionId = result[1];
            const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
            let subscriptionSize;
            await subscriptionSizeMutex.runExclusive(async () => {
              subscriptionSize = (transferredSizePerSubscriptionId.get(
                socketAndSubscriptionId,
              ) ?? 0) + message.length;
              transferredSizePerSubscriptionId.set(
                socketAndSubscriptionId,
                subscriptionSize,
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
              }),
            );
          }
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
              }),
            );
          }
        });
      }
    },
  );
  // HTTP+WebSocketサーバーの起動
  server.listen(listenPort);
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
  timeout: number = defaultTimeoutValue,
): void {
  const timeoutId = setTimeout(() => {
    socket.close();
  }, timeout);

  idleTimeouts.set(socket, timeoutId);
  timeoutValues.set(socket, timeout);
}

function resetIdleTimeout(
  socket: WebSocket,
  defaultTimeout: number = defaultTimeoutValue,
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

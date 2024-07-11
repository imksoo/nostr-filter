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
const NODE_ENV = process.env.NODE_ENV || "production";
if (NODE_ENV === "production") {
  // Suppress log and debug messages from console. console.info, console.warn, and console.error are still available in production mode
  console.log = (...data) => {

  };
  console.debug = (...data) => {

  };
}
const listenPort: number = parseInt(process.env.LISTEN_PORT ?? "8081"); // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl: string =
  process.env.UPSTREAM_HTTP_URL ?? "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl: string =
  process.env.UPSTREAM_WS_URL ?? "ws://localhost:8080"; // 上流のWebSocketサーバのURL
const NOSTR_MONITORING_BOT_PUBLIC_KEY: string =
  process.env.NOSTR_MONITORING_BOT_PUBLIC_KEY ?? "";
const CLASSIFICATION_EVENT_KIND = 9978;
const NSFW_CLASSIFICATION_D_TAG = "nostr-nsfw-classification";
const LANGUAGE_CLASSIFICATION_D_TAG = "nostr-language-classification";
const HATE_SPEECH_CLASSIFICATION_D_TAG = "nostr-hate-speech-classification";
const SENTIMENT_CLASSIFICATION_D_TAG = "nostr-sentiment-classification";

const pool = new SimplePool();
const fetcherNonPool = NostrFetcher.init();
const fetcher = NostrFetcher.withCustomPool(simplePoolAdapter(pool));
const relayRequestLimiter = pLimit(10);
const nHoursAgoInUnixTime = (hrs: number): number =>
  Math.floor((Date.now() - hrs * 60 * 60 * 1000) / 1000);

const nsfwClassificationCache = new LRUCache(
  {
    max: 200000,
    // how long to live in ms (3 days)
    ttl: 3 * 24 * 60 * 60 * 1000,
  },
);

const languageClassificationCache = new LRUCache(
  {
    max: 500000,
    // how long to live in ms (3 days)
    ttl: 3 * 24 * 60 * 60 * 1000,
  },
);

const hateSpeechClassificationCache = new LRUCache(
  {
    max: 200000,
    // how long to live in ms (3 days)
    ttl: 3 * 24 * 60 * 60 * 1000,
  },
);

const sentimentClassificationCache = new LRUCache(
  {
    max: 500000,
    // how long to live in ms (3 days)
    ttl: 3 * 24 * 60 * 60 * 1000,
  },
);

// Default constant variable specific for atrifat/nostr-filter fork. Basic explanations are provided in .env.sample 
const DEFAULT_FILTER_CONTENT_MODE = process.env.DEFAULT_FILTER_CONTENT_MODE || 'sfw';
const DEFAULT_FILTER_NSFW_CONFIDENCE = process.env.DEFAULT_FILTER_NSFW_CONFIDENCE || '75';
const DEFAULT_FILTER_LANGUAGE_MODE = process.env.DEFAULT_FILTER_LANGUAGE_MODE || 'all';
const DEFAULT_FILTER_LANGUAGE_CONFIDENCE = process.env.DEFAULT_FILTER_LANGUAGE_CONFIDENCE || '15';
const DEFAULT_FILTER_HATE_SPEECH_TOXIC_MODE = process.env.DEFAULT_FILTER_HATE_SPEECH_TOXIC_MODE || 'no';
const DEFAULT_FILTER_HATE_SPEECH_TOXIC_CONFIDENCE = process.env.DEFAULT_FILTER_HATE_SPEECH_TOXIC_CONFIDENCE || '75';
const DEFAULT_FILTER_HATE_SPEECH_TOXIC_EVALUATION_MODE = process.env.DEFAULT_FILTER_HATE_SPEECH_TOXIC_EVALUATION_MODE || 'max';
const DEFAULT_FILTER_SENTIMENT_MODE = process.env.DEFAULT_FILTER_SENTIMENT_MODE || 'all';
const DEFAULT_FILTER_SENTIMENT_CONFIDENCE = process.env.DEFAULT_FILTER_SENTIMENT_CONFIDENCE || '35';
const DEFAULT_FILTER_USER_MODE = process.env.DEFAULT_FILTER_USER_MODE || 'all';

// 書き込み用の上流リレーとの接続(あらかじめ接続しておいて、WS接続直後のイベントでも取りこぼしを防ぐため)
let upstreamWriteSocket = new WebSocket(upstreamWsUrl);

// NostrのEvent contentsのフィルタリング用正規表現パターンの配列
const contentFilters: RegExp[] = Object.keys(process.env)
  .filter(key => key.startsWith('MUTE_FILTER_'))
  .map(key => {
    const pattern = process.env[key]!;
    const match = pattern.match(/^\/(.+)\/([gimy]*)$/);
    if (!match) {
      return new RegExp(pattern);
    } else {
      return new RegExp(match[1], match[2]);
    }
  });

console.info(JSON.stringify({ msg: "process.env", ...process.env }));

// ブロックするユーザーの公開鍵の配列
const blockedPubkeys: string[] =
  (typeof process.env.BLOCKED_PUBKEYS !== "undefined" && process.env.BLOCKED_PUBKEYS !== "")
    ? process.env.BLOCKED_PUBKEYS.split(",").map((pubkey) => pubkey.trim())
    : [];
// Allow only whitelisted pubkey to write events
const whitelistedPubkeys: string[] =
  (typeof process.env.WHITELISTED_PUBKEYS !== "undefined" &&
    process.env.WHITELISTED_PUBKEYS !== "")
    ? process.env.WHITELISTED_PUBKEYS.split(",").map((pubkey) => pubkey.trim())
    : [];
// Filter proxy events
const filterProxyEvents = process.env.FILTER_PROXY_EVENTS === "true";
// Forward request headers to upstream
const enableForwardReqHeaders = process.env.ENABLE_FORWARD_REQ_HEADERS === "true";

// クライアントIPアドレスのCIDRフィルタ
const cidrRanges: string[] = Object.keys(process.env)
  .filter(key => key.startsWith('BLOCKED_IP_ADDR_'))
  .map(key => (process.env[key]!));

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
        parseInt(bits, 10),
      )
      }`,
    );

    return (ipNum & mask6) === (rangeNum & mask6);
  }

  return false;
}

console.info(
  JSON.stringify({
    msg: "configs",
    listenPort,
    upstreamHttpUrl,
    upstreamWsUrl,
    contentFilters: contentFilters.map(regex => `/${regex.source}/${regex.flags}`),
    blockedIPAddresses: cidrRanges,
  }),
);

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
  console.info(
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

const classificationDataFetcher = async (kind: number, monitoringBotPubkey: string, dtag: string, sinceHoursAgoToCheck: number = 24, untilHoursAgoToCheck: number = 0): Promise<NostrEventExt[]> => {
  return new Promise<NostrEventExt[]>(async (resolve, reject) => {
    const stride = sinceHoursAgoToCheck > 24 ? 2 : 1;
    const promiseList = [];
    for (let i = 0; i + untilHoursAgoToCheck < sinceHoursAgoToCheck; i += stride) {
      const since = (i + stride + untilHoursAgoToCheck) > sinceHoursAgoToCheck ? sinceHoursAgoToCheck : (i + stride + untilHoursAgoToCheck);
      const until = i + untilHoursAgoToCheck;
      console.debug("Fetching", dtag, "since", since, "hours ago", "until", until, "hours ago");
      promiseList.push(relayRequestLimiter(() => {
        return fetcherNonPool.fetchAllEvents(
          [upstreamWsUrl],
          /* filter */
          {
            kinds: [kind],
            "authors": [monitoringBotPubkey],
            "#d": [dtag],
            // "#e": subEventsId,
          },
          /* time range filter */
          {
            since: nHoursAgoInUnixTime(since),
            until: nHoursAgoInUnixTime(until),
          },
          /* fetch options (optional) */
          { sort: false, skipVerification: true },
        );
      }));
    }
    const joinResultRaw = await Promise.allSettled(promiseList);
    const joinResult: NostrEventExt[] = [];

    for (const tmpResult of joinResultRaw) {
      if (tmpResult.status === 'rejected') {
        console.error(tmpResult.reason.message);
        continue;
      }
      tmpResult.value.forEach(item => {
        joinResult.push(item);
      });
    }

    resolve(joinResult);
  });
};

const allClassificationDataFetcher = async (sinceHoursAgoToCheck: number = 24, untilHoursAgoToCheck: number = 0): Promise<NostrEventExt[]> => {
  return new Promise(async (resolve, reject) => {
    const joinResult: NostrEventExt[] = [];

    const promiseList = []
    promiseList.push(classificationDataFetcher(
      CLASSIFICATION_EVENT_KIND, NOSTR_MONITORING_BOT_PUBLIC_KEY, NSFW_CLASSIFICATION_D_TAG, sinceHoursAgoToCheck, untilHoursAgoToCheck));
    promiseList.push(classificationDataFetcher(
      CLASSIFICATION_EVENT_KIND, NOSTR_MONITORING_BOT_PUBLIC_KEY, LANGUAGE_CLASSIFICATION_D_TAG, sinceHoursAgoToCheck, untilHoursAgoToCheck));
    promiseList.push(classificationDataFetcher(
      CLASSIFICATION_EVENT_KIND, NOSTR_MONITORING_BOT_PUBLIC_KEY, HATE_SPEECH_CLASSIFICATION_D_TAG, sinceHoursAgoToCheck, untilHoursAgoToCheck));
    promiseList.push(classificationDataFetcher(
      CLASSIFICATION_EVENT_KIND, NOSTR_MONITORING_BOT_PUBLIC_KEY, SENTIMENT_CLASSIFICATION_D_TAG, sinceHoursAgoToCheck, untilHoursAgoToCheck));

    const joinResultRaw = await Promise.allSettled(promiseList);

    for (const tmpResult of joinResultRaw) {
      if (tmpResult.status === 'rejected') continue;
      tmpResult.value.forEach(item => {
        joinResult.push(item);
      });
    }

    resolve(joinResult);
  });
};

async function fetchClassificationDataHistory(
  sinceHoursAgoToCheck: number = 24, untilHoursAgoToCheck: number = 0
) {
  const classificationData = await allClassificationDataFetcher(sinceHoursAgoToCheck, untilHoursAgoToCheck);

  for (const classification of classificationData) {
    const eventTags = classification.tags.filter((tag) => tag[0] === "e");
    const dTags = classification.tags.filter((tag) => tag[0] === "d");
    if (eventTags.length === 0) continue;
    if (dTags.length === 0) continue;
    const eventId = eventTags[0][1];
    const dTag = dTags[0][1];

    switch (dTag) {
      case NSFW_CLASSIFICATION_D_TAG:
        if (nsfwClassificationCache.has(eventId)) break;
        nsfwClassificationCache.set(eventId, JSON.parse(classification.content));
        break;
      case LANGUAGE_CLASSIFICATION_D_TAG:
        if (languageClassificationCache.has(eventId)) break;
        languageClassificationCache.set(eventId, JSON.parse(classification.content));
        break;
      case HATE_SPEECH_CLASSIFICATION_D_TAG:
        if (hateSpeechClassificationCache.has(eventId)) break;
        hateSpeechClassificationCache.set(eventId, JSON.parse(classification.content));
        break;
      case SENTIMENT_CLASSIFICATION_D_TAG:
        if (sentimentClassificationCache.has(eventId)) break;
        sentimentClassificationCache.set(eventId, JSON.parse(classification.content));
        break;
      default:
        break;
    }
  }

  console.debug(classificationData[0]);
  console.debug(classificationData[classificationData.length - 1]);
  console.info("classificationData.length", classificationData.length);
}

async function subscribeClassificationDataHistory() {
  let subClassificationData = pool.sub(
    [upstreamWsUrl],
    [
      {
        kinds: [CLASSIFICATION_EVENT_KIND],
        "authors": [NOSTR_MONITORING_BOT_PUBLIC_KEY],
        "#d": [NSFW_CLASSIFICATION_D_TAG, LANGUAGE_CLASSIFICATION_D_TAG, HATE_SPEECH_CLASSIFICATION_D_TAG, SENTIMENT_CLASSIFICATION_D_TAG],
      },
    ],
    {
      id: "subClassification",
    },
  );
  let subClassificationDataEose = false;

  subClassificationData.on("eose", () => {
    // sub.unsub()
    subClassificationDataEose = true;
  });
  subClassificationData.on("event", (event) => {
    // Only process after eose event
    // if (!subClassificationDataEose) return;
    const eventTags = event.tags.filter((tag) => tag[0] === "e");
    const dTags = event.tags.filter((tag) => tag[0] === "d");
    if (eventTags.length === 0) return;
    if (dTags.length === 0) return;
    const eventId = eventTags[0][1];
    const dTag = dTags[0][1];

    try {
      const classificationData = JSON.parse(event.content);
      switch (dTag) {
        case NSFW_CLASSIFICATION_D_TAG:
          if (nsfwClassificationCache.has(eventId)) break;
          nsfwClassificationCache.set(eventId, classificationData);
          break;
        case LANGUAGE_CLASSIFICATION_D_TAG:
          if (languageClassificationCache.has(eventId)) break;
          languageClassificationCache.set(eventId, classificationData);
          break;
        case HATE_SPEECH_CLASSIFICATION_D_TAG:
          if (hateSpeechClassificationCache.has(eventId)) break;
          hateSpeechClassificationCache.set(eventId, classificationData);
          break;
        case SENTIMENT_CLASSIFICATION_D_TAG:
          if (sentimentClassificationCache.has(eventId)) break;
          sentimentClassificationCache.set(eventId, classificationData);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error(error);
    }
  });
}

async function listen(): Promise<void> {
  subscribeClassificationDataHistory();

  const sinceHoursAgoToCheck = 24 * 1;
  const untilHoursAgoToCheck = 4;
  const fetchStartTime = performance.now();
  // Fetch short time range data as initial data (fast response)
  await fetchClassificationDataHistory(untilHoursAgoToCheck, 0);
  console.info("ClassificationCache after initial data");
  console.info("nsfwClassificationCache.size", nsfwClassificationCache.size);
  console.info("languageClassificationCache.size", languageClassificationCache.size);
  console.info("hateSpeechClassificationCache.size", hateSpeechClassificationCache.size);
  console.info("sentimentClassificationCache.size", sentimentClassificationCache.size);
  console.info("ClassificationCache.size", nsfwClassificationCache.size + languageClassificationCache.size + hateSpeechClassificationCache.size + sentimentClassificationCache.size);

  // Fetch longer time range data in the background (maximum for 3 days)
  (async () => {
    await fetchClassificationDataHistory(sinceHoursAgoToCheck, untilHoursAgoToCheck);
    console.info("ClassificationCache after fetching", sinceHoursAgoToCheck, untilHoursAgoToCheck);
    console.info("nsfwClassificationCache.size", nsfwClassificationCache.size);
    console.info("languageClassificationCache.size", languageClassificationCache.size);
    console.info("hateSpeechClassificationCache.size", hateSpeechClassificationCache.size);
    console.info("sentimentClassificationCache.size", sentimentClassificationCache.size);
    console.info("ClassificationCache.size", nsfwClassificationCache.size + languageClassificationCache.size + hateSpeechClassificationCache.size + sentimentClassificationCache.size);
    await fetchClassificationDataHistory(sinceHoursAgoToCheck * 2, sinceHoursAgoToCheck);
    console.info("ClassificationCache after fetching", sinceHoursAgoToCheck * 2, sinceHoursAgoToCheck);
    console.info("nsfwClassificationCache.size", nsfwClassificationCache.size);
    console.info("languageClassificationCache.size", languageClassificationCache.size);
    console.info("hateSpeechClassificationCache.size", hateSpeechClassificationCache.size);
    console.info("sentimentClassificationCache.size", sentimentClassificationCache.size);
    console.info("ClassificationCache.size", nsfwClassificationCache.size + languageClassificationCache.size + hateSpeechClassificationCache.size + sentimentClassificationCache.size);
    await fetchClassificationDataHistory(sinceHoursAgoToCheck * 3, sinceHoursAgoToCheck * 2);
    console.info("ClassificationCache after fetching", sinceHoursAgoToCheck * 3, sinceHoursAgoToCheck * 2);
    console.info("nsfwClassificationCache.size", nsfwClassificationCache.size);
    console.info("languageClassificationCache.size", languageClassificationCache.size);
    console.info("hateSpeechClassificationCache.size", hateSpeechClassificationCache.size);
    console.info("sentimentClassificationCache.size", sentimentClassificationCache.size);
    console.info("ClassificationCache.size", nsfwClassificationCache.size + languageClassificationCache.size + hateSpeechClassificationCache.size + sentimentClassificationCache.size);
  })();

  const fetchEndTime = performance.now();
  console.info("fetchClassificationDataHistory elapsed time: ", fetchEndTime - fetchStartTime);

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
            console.warn(
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

      // Check whether we want to forward original request headers to the upstream server
      // This will be useful if the upstream server need original request headers to do operations like rate-limiting, etc.
      let wsClientOptions = enableForwardReqHeaders ? { headers: req.headers } : undefined;

      // 上流となるリレーサーバーと接続
      let upstreamSocket = new WebSocket(upstreamWsUrl, wsClientOptions);
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
        console.warn(
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
        console.warn(
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
        console.info(
          JSON.stringify({
            msg: "CONNECTED",
            ip,
            port,
            socketId,
            connectionCountForIP,
            headers: req.headers,
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
        let event: any[];
        try {
          event = JSON.parse(message);
        } catch (err: any) {
          event = ["INVALID", err.message ?? JSON.stringify(err)];
        }

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
          if (shouldRelay && whitelistedPubkeys.length > 0) {
            const isWhitelistPubkey = whitelistedPubkeys.includes(event[1].pubkey);

            if (!isWhitelistPubkey) {
              shouldRelay = false;
              because = "Only whitelisted pubkey can write events";
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

          if (event[0] === "INVALID") {
            shouldRelay = false;
            because = event[1];
          }
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
        console.warn(
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
          console.warn(
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
          let event: any[];
          try {
            event = JSON.parse(message);
          } catch (err: any) {
            event = ["INVALID", err.message ?? JSON.stringify(err)];
          }
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
            let cachedNsfwClassification;
            if (nsfwClassificationCache.has(eventId)) {
              cachedNsfwClassification = nsfwClassificationCache.get(eventId);
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
              //   cachedNsfwClassification = JSON.parse(
              //     classificationRawData.content,
              //   );
              //   nsfwClassificationCache.set(eventId, cachedNsfwClassification);
              // }
            }

            let isNsfw = false;

            // Filter content (NSFW/SFW) configurations
            let filterContentMode = searchParams.get("content") ?? DEFAULT_FILTER_CONTENT_MODE;
            let validFilterContentMode = ["all", "sfw", "partialsfw", "nsfw"];
            let nsfwConfidenceThresold = parseInt(
              searchParams.get("nsfw_confidence") ?? DEFAULT_FILTER_NSFW_CONFIDENCE,
            );
            nsfwConfidenceThresold = Number.isNaN(nsfwConfidenceThresold) ||
              nsfwConfidenceThresold < 0 || nsfwConfidenceThresold > 100
              ? 75 / 100
              : nsfwConfidenceThresold / 100;

            // Filter language configurations
            let filterLanguageModeString = searchParams.get("lang") ?? DEFAULT_FILTER_LANGUAGE_MODE;
            let filterLanguageMode = filterLanguageModeString.split(",").map(lang => lang.trim());
            let languageConfidenceThresold = parseInt(
              searchParams.get("lang_confidence") ?? DEFAULT_FILTER_LANGUAGE_CONFIDENCE,
            );
            languageConfidenceThresold = Number.isNaN(languageConfidenceThresold) ||
              languageConfidenceThresold < 0 || languageConfidenceThresold > 100
              ? 15
              : languageConfidenceThresold;

            // Filter hate speech (toxic content) configurations
            let filterHateSpeechContentMode = searchParams.get("toxic") ?? DEFAULT_FILTER_HATE_SPEECH_TOXIC_MODE;
            let validFilterHateSpeechContentMode = ["all", "yes", "no"];
            let hateSpeechContentConfidenceThresold = parseInt(
              searchParams.get("toxic_confidence") ?? DEFAULT_FILTER_HATE_SPEECH_TOXIC_CONFIDENCE,
            );
            hateSpeechContentConfidenceThresold = Number.isNaN(hateSpeechContentConfidenceThresold) ||
              hateSpeechContentConfidenceThresold < 0 || hateSpeechContentConfidenceThresold > 100
              ? 75 / 100
              : hateSpeechContentConfidenceThresold / 100;
            let filterHateSpeechContentEvalMode = searchParams.get("toxic_eval") ?? DEFAULT_FILTER_HATE_SPEECH_TOXIC_EVALUATION_MODE;
            let validFilterHateSpeechContentEvalMode = ["max", "sum"];

            // Filter sentiment configurations
            let filterSentimentModeString = searchParams.get("sentiment") ?? DEFAULT_FILTER_SENTIMENT_MODE;
            let filterSentimentMode = filterSentimentModeString.split(",").map(sentiment => sentiment.trim().toLowerCase());
            let sentimentConfidenceThresold = parseInt(
              searchParams.get("sentiment_confidence") ?? DEFAULT_FILTER_SENTIMENT_CONFIDENCE,
            );
            sentimentConfidenceThresold = Number.isNaN(sentimentConfidenceThresold) ||
              sentimentConfidenceThresold < 0 || sentimentConfidenceThresold > 100
              ? 35 / 100
              : sentimentConfidenceThresold / 100;

            let filterUserMode = searchParams.get("user") ?? DEFAULT_FILTER_USER_MODE;
            let validFilterUserMode = ["all", "nostr", "activitypub"];
            const contentWarningExist = hasContentWarning(event[2].tags ?? []);
            const nsfwHashtagExist = hasNsfwHashtag(
              extractHashtags(event[2].tags ?? []),
            );

            // Check classification results
            if (cachedNsfwClassification) {
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
                cachedNsfwClassification,
                nsfwConfidenceThresold,
              );
            }

            const isSensitiveContent = isNsfw || contentWarningExist ||
              nsfwHashtagExist;
            switch (filterContentMode) {
              case "sfw":
                if (!shouldRelay) break;
                // Accept as long as it is not nsfw or it has not content warning or it has not nswf hashtag
                shouldRelay = !isSensitiveContent;
                if (!shouldRelay) because = "Non-NSFW content only filtered";
                break;
              case "partialsfw":
                if (!shouldRelay) break;
                // Accept as long as it is not nsfw or it has content warning or it has nsfw hashtag
                shouldRelay = false;
                if (contentWarningExist || nsfwHashtagExist) {
                  shouldRelay = true;
                }
                else if (!isNsfw) {
                  shouldRelay = true;
                }
                if (!shouldRelay) because = "Partial NSFW content only filtered";
                break;
              case "nsfw":
                if (!shouldRelay) break;
                shouldRelay = isSensitiveContent;
                if (!shouldRelay) because = "NSFW content only filtered";
                break;
              default:
                if (!shouldRelay) break;
                shouldRelay = true;
                because = "";
                break;
            }

            // console.log("isSensitiveContent", isSensitiveContent);

            let cachedLanguageClassification: any;
            if (languageClassificationCache.has(eventId)) {
              cachedLanguageClassification = languageClassificationCache.get(eventId) ?? [];
            }
            else {
              // TODO checkLanguageClassificationWithAttempt is function that try to check language classification with several attempts
              // However, this function is not fully tested and there are bugs with any notes event before EOSE, thus setting the default to empty arrray.
              // Further analysis needed before using this function.
              const checkLanguageClassificationWithAttempt = async (eventId: any, numAttempt: number = 2) => {
                let counter = 0;
                let result = undefined;

                while (counter < numAttempt) {
                  console.info("Checking Language for ", eventId, ", waiting for ", (counter + 1) * 500, Date.now());
                  // Force async sleep await for certain times
                  await new Promise(r => setTimeout(r, (counter + 1) * 500));
                  console.info("Checking Language for ", eventId, ", after waiting for ", (counter + 1) * 500, Date.now());
                  if (languageClassificationCache.has(eventId)) {
                    result = languageClassificationCache.get(eventId);
                    console.info("Found Language for ", eventId, result);
                    break;
                  }
                  counter++;
                }
                return result;
              };
              // cachedLanguageClassification = await checkLanguageClassificationWithAttempt(eventId);
              cachedLanguageClassification = cachedLanguageClassification ?? [];
            }

            if (filterLanguageMode.includes("all")) {
              // do nothing since shouldRelay default value is true
            }
            else {
              // filter based on language
              const languageRulesFilter = function (
                classifications: any,
                filterLanguageMode: string[],
                languageConfidenceThresold: number = 15,
              ): boolean {
                let result = false;
                for (const languageClassification of classifications) {
                  const hasProbablyTargetLanguage = filterLanguageMode.includes(languageClassification.language);
                  const highConfidence = parseFloat(languageClassification.confidence) >= languageConfidenceThresold;
                  // english doesn't use confidence thresold check
                  if (hasProbablyTargetLanguage && languageClassification.language === 'en') {
                    result = true;
                    break;
                  }
                  // other language use confidence thresold check
                  else if (hasProbablyTargetLanguage && highConfidence) {
                    result = true;
                    break;
                  }
                  // Debugging language check
                  // if (hasProbablyTargetLanguage && !highConfidence) {
                  //   console.info("low confidence = ", event[2].content, JSON.stringify(cachedLanguageClassification));
                  // }
                }
                return result;
              };

              let hasTargetLanguage = false;
              hasTargetLanguage = languageRulesFilter(cachedLanguageClassification, filterLanguageMode, languageConfidenceThresold);

              if (!hasTargetLanguage && shouldRelay) {
                shouldRelay = false;
                because = "Does not have target language: " + filterLanguageMode.join(", ");
              }
            }

            // Check hate speech (toxic content) classification results
            let cachedHateSpeechClassificationCache: any;
            if (hateSpeechClassificationCache.has(eventId)) {
              cachedHateSpeechClassificationCache = hateSpeechClassificationCache.get(eventId) ?? [];
            }

            let isProbablyHateSpeech = false;
            if (cachedHateSpeechClassificationCache) {
              // Get maximum probability of all classification label
              const maxScoreHateSpeechDetection = Math.max(...Object.values(cachedHateSpeechClassificationCache)
                .map((score: any) => parseFloat(score)));

              // Get sum probability of all classification label
              let sumScoreHateSpeechDetection = Object.values(cachedHateSpeechClassificationCache)
                .map((score: any) => parseFloat(score))
                .reduce((a, b) => a + b, 0)
              sumScoreHateSpeechDetection = (sumScoreHateSpeechDetection >= 1) ? 0.99999999999 : sumScoreHateSpeechDetection;

              switch (filterHateSpeechContentEvalMode) {
                case 'sum':
                  isProbablyHateSpeech = sumScoreHateSpeechDetection >= hateSpeechContentConfidenceThresold;
                  break;
                default:
                  isProbablyHateSpeech = maxScoreHateSpeechDetection >= hateSpeechContentConfidenceThresold;
                  break;
              }
            }

            switch (filterHateSpeechContentMode) {
              case "no":
                if (!shouldRelay) break;

                // Don't filter if parameter: content=all
                if (filterContentMode === 'all') break;

                // Don't filter if parameter: content=partialsfw and it has content warning or nsfw hashtag
                if (filterContentMode === 'partialsfw') {
                  if (contentWarningExist || nsfwHashtagExist) break;
                }

                // Accept as long as it is not probably hate speech
                shouldRelay = !isProbablyHateSpeech;
                if (!shouldRelay) because = "Non hate speech (toxic content) only filtered";
                break;
              case "yes":
                if (!shouldRelay) break;
                // Accept as long as it is probably hate speech
                shouldRelay = isProbablyHateSpeech;
                if (!shouldRelay) because = "Hate speech (Toxic content) only filtered";
                break;
              default:
                break;
            }

            // Check sentiment classification results
            let cachedSentimentClassificationCache: any = sentimentClassificationCache.get(eventId);

            if (!filterSentimentMode.includes("all")) {
              // filter based on sentiment
              const sentimentRulesFilter = function (
                classification: any,
                filterSentimentMode: string[],
                sentimentConfidenceThresold: number = 35,
              ): boolean {
                let result = false;
                for (const label in classification) {
                  const hasProbablyTargetSentiment = filterSentimentMode.includes(label);
                  const highConfidence = parseFloat(classification[label] ?? 0.0) >= sentimentConfidenceThresold;
                  if (hasProbablyTargetSentiment && highConfidence) {
                    result = true;
                    break;
                  }
                }
                return result;
              };

              const hasTargetSentiment = sentimentRulesFilter(cachedSentimentClassificationCache, filterSentimentMode, sentimentConfidenceThresold);

              if (!hasTargetSentiment && shouldRelay) {
                shouldRelay = false;
                because = "Does not have target sentiment: " + filterSentimentMode.join(", ");
              }
            }

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
          } else if (event[0] === "INVALID") {
            shouldRelay = false;
            because = event[1];
          }

          let result: any[];
          try {
            result = JSON.parse(message);
          } catch (err: any) {
            result = ["INVALID", err.message ?? JSON.stringify(err)];
          }
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
          } else if (resultType === "INVALID") {
            shouldRelay = false;
            because = result[1];
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

# nostr-filter

`nostr-filter` is a Nostr relay front filter that sits in front of an upstream relay and filters traffic by content, pubkey, and client IP address. It also measures request cost from `REQ` to `EOSE`, accumulates that cost per client IP, warns on heavy single requests, and temporarily blocks clients whose cumulative cost becomes too high.

The project is intended to run as a Docker Compose service and expose a filtered WebSocket/HTTP endpoint to clients while forwarding allowed traffic to an upstream relay.

## What it does

- Filters downstream `EVENT` messages by content regex, blocked pubkeys, and optional proxy-event rules.
- Blocks clients by CIDR range before they are accepted.
- Tracks `REQ` to `EOSE` elapsed time as processing cost.
- Accumulates processing cost per client IP across active connections.
- Logs an `IP PROCESSING COST SUMMARY` when the active connection count for an IP returns to zero.
- Emits a `HEAVY SINGLE REQ` warning when one request is expensive even if it does not trigger a block.
- Temporarily blocks an IP when cumulative processing cost reaches the configured threshold, then automatically unblocks it after the configured duration.
- Serves static files from `./static/` for normal HTTP requests. A `GET /` returns `static/index.html`.

## Runtime layout

Current source layout:

- [main.ts](/home/strfry/nostr-filter/main.ts): entrypoint, HTTP server, WebSocket orchestration.
- [config.ts](/home/strfry/nostr-filter/config.ts): environment variable parsing and startup config logging.
- [filters.ts](/home/strfry/nostr-filter/filters.ts): message filtering decisions.
- [processing-state.ts](/home/strfry/nostr-filter/processing-state.ts): per-IP connection and processing-cost state.
- [subscriptions.ts](/home/strfry/nostr-filter/subscriptions.ts): tracked `REQ` state per socket.
- [network.ts](/home/strfry/nostr-filter/network.ts): client address parsing and idle timeout helpers.
- [logger.ts](/home/strfry/nostr-filter/logger.ts): JSON log output through `log(level, payload)`.
- [compose.yaml](/home/strfry/nostr-filter/compose.yaml): local deployment definition.

## Requirements

- Docker
- Docker Compose

## Quick start

1. Clone the repository and move into it.

```sh
git clone <your-fork-or-repo-url>
cd nostr-filter
```

2. Create your runtime configuration.

```sh
cp .env.sample .env
```

3. Edit `.env` for your upstream relay and filtering rules.

4. Build and start the service.

```sh
docker compose build
docker compose up -d
```

5. Inspect logs.

```sh
docker compose logs -f filter
```

## Configuration

Runtime configuration is loaded from `.env`. See [.env.sample](/home/strfry/nostr-filter/.env.sample) for a complete example.

Core relay settings:

```ini
NODE_ENV=production
LISTEN_PORT=8081
UPSTREAM_HTTP_URL=http://192.168.1.1:8080
UPSTREAM_WS_URL=ws://192.168.1.1:8080
UPSTREAM_WS_FOR_FAST_BOT_URL=ws://192.168.1.1:8081
ENABLE_FORWARD_REQ_HEADERS=true
MAX_WEBSOCKET_PAYLOAD_SIZE=1000000
FILTER_PROXY_EVENTS=false
```

Filtering and blocking settings:

```ini
BLOCKED_PUBKEYS=
BLOCKED_REQ_KINDS=1009,22668,22689,22608,22837,22817,22760,22628,20000,20001,1000
WHITELISTED_PUBKEYS=
BLOCKED_IP_ADDR_1=43.205.189.224/32
MUTE_FILTER_1=/spam/i
MUTE_FILTER_2=/lnbc/
```

Processing-cost settings:

```ini
PROCESSING_COST_BLOCK_THRESHOLD_MS=60000
PROCESSING_COST_BLOCK_DURATION_SEC=600
BLOCKED_ACTION_BAN_DURATION_SEC=600
CONCURRENT_REQ_BAN_THRESHOLD=3
CONCURRENT_REQ_BAN_DURATION_SEC=60
SINGLE_REQ_PROCESSING_COST_WARN_THRESHOLD_MS=10000
MAX_TRACKED_REQS_PER_SOCKET=100
MAX_CONCURRENT_REQS_PER_SOCKET=16
```

### Environment variables

- `NODE_ENV`
  In `production`, `DEBUG` level logs are suppressed. `INFO`, `WARN`, and `ERROR` remain enabled.
- `LISTEN_PORT`
  Port exposed by the filter service.
- `UPSTREAM_HTTP_URL`
  Upstream relay HTTP endpoint used for non-WebSocket proxy requests.
- `UPSTREAM_WS_URL`
  Main upstream WebSocket endpoint.
- `UPSTREAM_WS_FOR_FAST_BOT_URL`
  Secondary upstream WebSocket used for forwarding downstream `EVENT` writes.
- `ENABLE_FORWARD_REQ_HEADERS`
  When `true`, forwards the original request headers to the upstream WebSocket connection and explicitly sets `X-Real-IP`, `X-Real-Port`, and `X-Forwarded-*` based on the client connection seen by `nostr-filter`.
- `MAX_WEBSOCKET_PAYLOAD_SIZE`
  Maximum accepted WebSocket message size in bytes.
- `FILTER_PROXY_EVENTS`
  Enables additional filtering for proxy-style events.
- `BLOCKED_PUBKEYS`
  Comma-separated hex pubkeys that are always blocked.
- `BLOCKED_REQ_KINDS`
  Comma-separated event kinds. If a client sends a `REQ` whose `kinds` contains any of these values, or writes an `EVENT` with one of these kinds, `nostr-filter` rejects it before forwarding it upstream.
- `WHITELISTED_PUBKEYS`
  Comma-separated hex pubkeys that bypass some filtering checks where applicable.
- `BLOCKED_IP_ADDR_*`
  CIDR entries used to deny client connections immediately.
- `MUTE_FILTER_*`
  Regex patterns applied to event content.
- `PROCESSING_COST_BLOCK_THRESHOLD_MS`
  Cumulative per-IP `REQ -> EOSE` cost threshold in milliseconds. `0` disables cumulative blocking.
- `PROCESSING_COST_BLOCK_DURATION_SEC`
  How long an IP remains blocked after crossing the cumulative threshold.
- `BLOCKED_ACTION_BAN_DURATION_SEC`
  How long an IP remains blocked after it triggers a blocked `REQ` or blocked `EVENT` kind.
- `CONCURRENT_REQ_BAN_THRESHOLD`
  Number of `Blocked by too many concurrent REQs` violations from one IP before it is temporarily blocked.
- `CONCURRENT_REQ_BAN_DURATION_SEC`
  How long an IP remains blocked after repeatedly hitting the concurrent-`REQ` limit.
- `SINGLE_REQ_PROCESSING_COST_WARN_THRESHOLD_MS`
  Per-request warning threshold in milliseconds. `0` disables heavy single-request warnings.
- `MAX_TRACKED_REQS_PER_SOCKET`
  Maximum number of tracked request payloads kept in memory for one socket.
- `MAX_CONCURRENT_REQS_PER_SOCKET`
  Maximum number of active subscriptions allowed on one client WebSocket. A new `REQ` above this limit is rejected by `nostr-filter` before it reaches `strfry`.

## Request-cost tracking

For each subscription:

1. The filter stores the incoming `REQ` payload in memory.
2. When the corresponding `EOSE` arrives from upstream, the elapsed time is measured.
3. That elapsed time is logged as `processingCostMs`.
4. The value is added to the cumulative total for the client IP.

This gives you two separate signals:

- Single-request cost
  Useful for identifying one expensive query.
- Cumulative per-IP cost
  Useful for identifying abusive or persistent expensive usage patterns.

### Heavy single requests

When one request exceeds `SINGLE_REQ_PROCESSING_COST_WARN_THRESHOLD_MS`, the filter emits a `HEAVY SINGLE REQ` warning log with:

- `ip`
- `socketId`
- `subscriptionId`
- `processingCostMs`
- `req`
- `trackedReqsForSocket`

This is useful when a client never crosses the cumulative block threshold but still sends expensive searches.

### Concurrent `REQ` limit

`nostr-filter` also enforces a per-socket active subscription cap before forwarding `REQ` messages upstream.

- Existing subscription IDs may be replaced by another `REQ` with the same ID.
- New subscription IDs above `MAX_CONCURRENT_REQS_PER_SOCKET` are rejected immediately.
- The filter emits `REQ BLOCKED` and closes the socket with a policy error before `strfry` can emit `too many concurrent REQs`.
- If the same IP hits this limit `CONCURRENT_REQ_BAN_THRESHOLD` times, the IP is temporarily blocked for `CONCURRENT_REQ_BAN_DURATION_SEC` and the filter emits `IP RULE BLOCKED`.

### Blocked `REQ` kinds

If `BLOCKED_REQ_KINDS` is set, `nostr-filter` rejects:

- any `REQ` whose `kinds` array contains one of those values
- any downstream `EVENT` write whose `kind` matches one of those values

- The triggering IP is temporarily blocked for `BLOCKED_ACTION_BAN_DURATION_SEC`
- The filter emits `IP RULE BLOCKED`
- Blocked `REQ` messages emit `REQ BLOCKED`, return a `NOTICE`, and close the socket before reaching `strfry`
- Blocked `EVENT` writes are rejected before they reach `strfry`, and sockets for that IP are closed

### Temporary cumulative blocks

When cumulative per-IP cost reaches `PROCESSING_COST_BLOCK_THRESHOLD_MS`:

- the filter emits `IP PROCESSING COST BLOCKED`
- all current sockets for that IP receive a block notice and are closed
- new connections from that IP are rejected until the block expires
- the IP is automatically unblocked after `PROCESSING_COST_BLOCK_DURATION_SEC`
- unblock is logged as `IP PROCESSING COST UNBLOCKED`

When the active connection count for an IP becomes zero, the filter emits `IP PROCESSING COST SUMMARY`. If the IP is still blocked at that time, the summary indicates that reset is pending until unblock.

## Logs

Logs are emitted as single-line JSON objects through the internal logger. Example classes of log messages:

- `CONNECTED`
- `EOSE`
- `HEAVY SINGLE REQ`
- `IP PROCESSING COST BLOCKED`
- `IP PROCESSING COST UNBLOCKED`
- `IP PROCESSING COST SUMMARY`
- `CONNECTING BLOCKED`
- `EVENT`
- `EVENT BLOCKED`

Typical log inspection commands:

```sh
docker compose logs --no-color filter
docker compose logs --no-color filter | rg 'IP PROCESSING COST BLOCKED|HEAVY SINGLE REQ'
docker compose logs --no-color filter | rg '"msg":"EOSE"'
```

## Static files and HTTP behavior

- `GET /` returns `static/index.html`
- other normal HTTP requests under `./static/` are served as static files
- requests with `Accept: application/nostr+json` are proxied upstream

Static assets are mounted from [static](/home/strfry/nostr-filter/static) into the container by [compose.yaml](/home/strfry/nostr-filter/compose.yaml).

## Development notes

- The project currently compiles TypeScript directly into the container image.
- There is no dedicated test suite yet.
- A quick verification command is:

```sh
npx tsc --noEmit
```

## Operational notes

- The current Docker logging driver is `json-file` with rotation configured in [compose.yaml](/home/strfry/nostr-filter/compose.yaml).
- The service uses several TCP-related sysctls tuned for relay-style traffic.
- Request payloads are intentionally kept in memory only up to `MAX_TRACKED_REQS_PER_SOCKET` so the process can log the triggering request when a heavy request or cumulative block occurs.

## License

MIT

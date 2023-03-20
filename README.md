# nostr-filter

`nostr-filter` is a Nostr relay server that filters messages based on regular expressions. When a message is received from a Nostr client, it checks if the message contains any of the regular expressions in contentFilters. If it matches, the message is ignored. If it doesn't match, the message is forwarded to an upstream Nostr relay server.

## Installation

To run `nostr-filter`, you need to have Docker and Docker Compose installed.

1. Clone this repository.

Change directory to the cloned repository.

```
cd nostr-filter/
```

2. Build the Docker image.

```
docker compose build
```

3. Start the Docker container.

```
docker compose up -d
```

## Configuration

In the filter.ts file, you can configure the following options:

* listenPort: The port number to listen to WebSocket connections from clients.
* upstreamHttpUrl: The URL of the upstream WebSocket server for non-WebSocket requests.
* upstreamWsUrl: The URL of the upstream WebSocket server for WebSocket requests.
* contentFilters: An array of regular expression patterns to filter messages.

## Usage

To use nostr-filter, you need a Nostr client that sends messages to the WebSocket server. You can connect to the Nostr relay using the URL ws://<server_address>:<listen_port>.

If a message matches any of the regular expressions in contentFilters, the WebSocket server will ignore the message. If it doesn't match, the WebSocket server will forward the message to the upstream WebSocket server.

## License
nostr-filter is licensed under the MIT License.

# Introduction

Nostr-filter is a user-friendly filtering program designed to improve the management of your Nostr relay server. This program enables you to easily filter out undesired events, block specific users, and limit access from certain IP addresses or ranges. By employing regular expressions for content filtering, a list of public keys for user blocking, and a list of CIDR notations for IP address filtering, you can effortlessly tailor the settings to your preferences and ensure a smooth and optimized experience for your Nostr relay users.

## Fork Differences and Features

[atrifat/nostr-filter](https://github.com/atrifat/nostr-filter) is a custom fork of [imksoo/nostr-filter](https://github.com/imksoo/nostr-filter) which focuses on additional filtering features using [atrifat/nostr-monitoring-tool](https://github.com/atrifat/nostr-monitoring-tool) data such as:

- Language filtering
- SFW/NSFW Content filtering
- Hate speech (Toxic Comments) filtering
- and other features listed in [atrifat/nostr-monitoring-tool](https://github.com/atrifat/nostr-monitoring-tool)

[atrifat/nostr-filter](https://github.com/atrifat/nostr-filter) is also main component of [atrifat/nostr-filter-relay](https://github.com/atrifat/nostr-filter-relay) which act as frontend proxy filter relay.

## Installation

To run `nostr-filter`, you need to have Docker and Docker Compose installed.

1. Clone this repository.

Change directory to the cloned repository.

```shell
cd nostr-filter/
```

2. Build the Docker image.

```shell
docker compose build
```

3. Start the Docker container.

```shell
docker compose up -d
```

## Configuration

In the .env file, you can configure the following options:

```ini
LISTEN_PORT=8081
UPSTREAM_HTTP_URL=http://192.168.1.1:8080
UPSTREAM_WS_URL=ws://192.168.1.1:8080
```

In the filter.ts file, you can configure the following options:

1. Content Filters
contentFilters is an array of regular expression patterns used to filter Nostr event contents. To add a new filtering pattern, simply add a new regular expression pattern to the array. For example:

```typescript
const contentFilters: RegExp[] = [
  /avive/i,
  /web3/i,
  /lnbc/,
  // Add more patterns below
];
```

2. Blocked Public Keys
blockedPubkeys is an array of public keys that represent users you wish to block. To block a user, add their public key to the array. For example:

```typescript
const blockedPubkeys: string[] = [
  "examplePublicKey1",
  "examplePublicKey2",
  // Add more public keys to block below
];
```

3. Client IP Address CIDR Filters
cidrRanges is an array of CIDR notations representing IP addresses or ranges that you want to filter. To add a new CIDR filter, simply add the IP address or range to the array. For example:

```typescript
const cidrRanges: string[] = [
  "1.2.3.4/32",
  "5.67.89.101/32",
  // Add more IP addresses or ranges below
];
```
Once you have configured the settings according to your needs, the script will filter Nostr event contents, block users, and filter client IP addresses based on your defined patterns and lists.

## Usage

To use nostr-filter, you need a Nostr client that sends messages to the WebSocket server. You can connect to the Nostr relay using the URL ws://<server_address>:<listen_port>.

## Contributing

We welcome contributions from the community. If you would like to contribute to nostr-filter, please follow these steps:

1. Fork the repository.
2. Create a new branch for your changes.
3. Make your changes and commit them to your branch.
4. Submit a pull request with a description of your changes.

Please make sure to follow the code style and conventions used in the project. If you have any questions or need help, feel free to open an issue.

## License
nostr-filter is licensed under the MIT License.

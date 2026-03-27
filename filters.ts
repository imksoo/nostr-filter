import * as net from "net";
import { blockedPubkeys, blockedReqKinds, contentFilters, filterProxyEvents, whitelistedPubkeys } from "./config";
import { RelayDecision } from "./types";

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);

  if (net.isIPv4(ip) && net.isIPv4(range)) {
    const ipNum = ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
    const rangeNum = range.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
    return (ipNum & mask) === (rangeNum & mask);
  }

  if (net.isIPv6(ip) && net.isIPv6(range)) {
    const ipNum = BigInt(`0x${ip.replace(/:/g, "")}`);
    const rangeNum = BigInt(`0x${range.replace(/:/g, "")}`);
    const mask6 = BigInt(`0x${"f".repeat(32 - parseInt(bits, 10))}${"0".repeat(parseInt(bits, 10))}`);
    return (ipNum & mask6) === (rangeNum & mask6);
  }

  return false;
}

function evaluateKind1Event(event: { content: string; pubkey: string; tags: string[][] }, options: { filterProxyTags: boolean }): RelayDecision {
  for (const filter of contentFilters) {
    if (filter.test(event.content)) return { shouldRelay: false, because: "Blocked event by content filter" };
  }

  for (const block of blockedPubkeys) {
    if (event.pubkey === block) return { shouldRelay: false, because: "Blocked event by pubkey" };
  }

  if (options.filterProxyTags) {
    for (const tag of event.tags) {
      if (tag[0] === "proxy") return { shouldRelay: false, because: "Blocked event by proxied event" };
    }
  }

  return { shouldRelay: true, because: "" };
}

export function evaluateDownstreamEvent(event: any[]): RelayDecision {
  if (event[0] !== "EVENT") return { shouldRelay: true, because: "" };
  if (blockedReqKinds.includes(event[1].kind)) return { shouldRelay: false, because: `Blocked event by blocked kind: ${event[1].kind}` };

  let decision: RelayDecision = { shouldRelay: true, because: "" };
  if (event[1].kind === 1) {
    decision = evaluateKind1Event(event[1], { filterProxyTags: filterProxyEvents });
  }

  if (decision.shouldRelay && whitelistedPubkeys.length > 0) {
    const isWhitelistPubkey = whitelistedPubkeys.includes(event[1].pubkey);
    if (!isWhitelistPubkey) {
      return { shouldRelay: false, because: "Only whitelisted pubkey can write events" };
    }
  }

  return decision;
}

export function evaluateUpstreamEvent(event: any[]): RelayDecision {
  if (event[0] === "INVALID") return { shouldRelay: false, because: event[1] };
  if (event[0] === "EVENT" && event[2].kind === 1) {
    return evaluateKind1Event(event[2], { filterProxyTags: false });
  }
  return { shouldRelay: true, because: "" };
}

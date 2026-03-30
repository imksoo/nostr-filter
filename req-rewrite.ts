import { reqRewriteDisabledKinds, reqRewriteEnabledKinds } from "./config";
import { ReqExecutionStats } from "./types";

type ReqRewriteMode = ReqExecutionStats["mode"];
type ReqFilter = Record<string, unknown>;

type ReqRewritePlan = {
  mode: ReqRewriteMode;
  rewrittenEvent: any[];
  isMessageEdited: boolean;
};

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number");
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isReqFilter(value: unknown): value is ReqFilter {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTagValues(event: Record<string, unknown>, tagName: string): string[] {
  const tags = Array.isArray(event.tags) ? event.tags : [];
  return tags
    .filter((tag): tag is unknown[] => Array.isArray(tag))
    .map((tag) => (tag.length >= 2 && tag[0] === tagName && typeof tag[1] === "string" ? tag[1] : undefined))
    .filter((tagValue): tagValue is string => typeof tagValue === "string");
}

function shouldRewriteReqFilter(reqFilter: ReqFilter): boolean {
  const kinds = toNumberArray(reqFilter.kinds);
  if (kinds.length !== 1) return false;

  const kind = kinds[0];
  if (reqRewriteDisabledKinds.includes(kind) || !reqRewriteEnabledKinds.includes(kind)) return false;

  return toStringArray(reqFilter["#p"]).length > 0 || toStringArray(reqFilter["#e"]).length > 0;
}

function rewriteReqFilter(reqFilter: ReqFilter): ReqFilter {
  const rewrittenFilter = { ...reqFilter };
  delete rewrittenFilter["#p"];
  delete rewrittenFilter["#e"];
  return rewrittenFilter;
}

function getReqFilters(reqPayload: unknown): ReqFilter[] {
  if (Array.isArray(reqPayload)) return reqPayload.filter(isReqFilter);
  return isReqFilter(reqPayload) ? [reqPayload] : [];
}

function eventMatchesReqFilter(reqFilter: ReqFilter, event: Record<string, unknown>): boolean {
  const ids = toStringArray(reqFilter.ids);
  const eventId = typeof event.id === "string" ? event.id : undefined;
  if (ids.length > 0 && (!eventId || !ids.some((id) => eventId.startsWith(id)))) return false;

  const authors = toStringArray(reqFilter.authors);
  if (authors.length > 0 && (typeof event.pubkey !== "string" || !authors.includes(event.pubkey))) return false;

  const kinds = toNumberArray(reqFilter.kinds);
  if (kinds.length > 0 && (typeof event.kind !== "number" || !kinds.includes(event.kind))) return false;

  if (typeof reqFilter.since === "number" && (typeof event.created_at !== "number" || event.created_at < reqFilter.since)) return false;
  if (typeof reqFilter.until === "number" && (typeof event.created_at !== "number" || event.created_at > reqFilter.until)) return false;

  for (const tagKey of Object.keys(reqFilter).filter((key) => key.startsWith("#"))) {
    const tagValues = toStringArray(reqFilter[tagKey]);
    if (tagValues.length === 0) continue;
    const eventTagValues = new Set(getTagValues(event, tagKey.slice(1)));
    if (!tagValues.some((tagValue) => eventTagValues.has(tagValue))) return false;
  }

  return true;
}

export function planReqRewrite(event: any[]): ReqRewritePlan {
  if (event[0] !== "REQ" || event.length < 3) return { mode: "passthrough", rewrittenEvent: event, isMessageEdited: false };

  let isMessageEdited = false;
  const rewrittenFilters = event.slice(2).map((reqFilter) => {
    if (!isReqFilter(reqFilter) || !shouldRewriteReqFilter(reqFilter)) return reqFilter;
    isMessageEdited = true;
    return rewriteReqFilter(reqFilter);
  });

  if (!isMessageEdited) return { mode: "passthrough", rewrittenEvent: event, isMessageEdited: false };

  return { mode: "strip_p_e_tags", rewrittenEvent: [event[0], event[1], ...rewrittenFilters], isMessageEdited: true };
}

export function shouldRelayRewrittenEvent(reqPayload: unknown, upstreamEvent: unknown): boolean {
  if (typeof upstreamEvent !== "object" || upstreamEvent === null || Array.isArray(upstreamEvent)) return false;
  const reqFilters = getReqFilters(reqPayload);
  if (reqFilters.length === 0) return true;
  const event = upstreamEvent as Record<string, unknown>;
  return reqFilters.some((reqFilter) => eventMatchesReqFilter(reqFilter, event));
}

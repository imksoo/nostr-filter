import { reqRewriteDisabledKinds, reqRewriteEnabledKinds } from "./config";
import { ReqAnalysis, ReqExecutionStats, ReqFilterAnalysis, ReqShape } from "./types";

type ReqFilter = Record<string, unknown>;

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

function getReqFilters(reqPayload: unknown): ReqFilter[] {
  if (Array.isArray(reqPayload)) return reqPayload.filter(isReqFilter);
  return isReqFilter(reqPayload) ? [reqPayload] : [];
}

function getRewriteEligibleModes(reqFilter: ReqFilter): ReqExecutionStats["mode"][] {
  const kinds = toNumberArray(reqFilter.kinds);
  if (kinds.length !== 1) return [];

  const kind = kinds[0];
  if (reqRewriteDisabledKinds.includes(kind)) return [];
  if (toStringArray(reqFilter["#p"]).length === 0 && toStringArray(reqFilter["#e"]).length === 0) return [];

  return ["strip_p_e_tags"];
}

function analyzeReqFilter(reqFilter: ReqFilter, filterIndex: number): ReqFilterAnalysis {
  const tagCounts = Object.fromEntries(
    Object.keys(reqFilter)
      .filter((key) => key.startsWith("#"))
      .sort()
      .map((key): [string, number] => [key, toStringArray(reqFilter[key]).length])
      .filter(([, count]) => count > 0),
  );

  return {
    filterIndex,
    kinds: toNumberArray(reqFilter.kinds).sort((a, b) => a - b),
    idsCount: toStringArray(reqFilter.ids).length,
    authorsCount: toStringArray(reqFilter.authors).length,
    tagCounts,
    hasSince: typeof reqFilter.since === "number",
    hasUntil: typeof reqFilter.until === "number",
    hasSearch: typeof reqFilter.search === "string" && reqFilter.search.length > 0,
    limit: typeof reqFilter.limit === "number" ? reqFilter.limit : undefined,
    rewriteEligibleModes: getRewriteEligibleModes(reqFilter),
  };
}

function buildReqShape(filters: ReqFilter[], analyses: ReqFilterAnalysis[]): ReqShape {
  const otherTagKeys = Array.from(
    new Set(
      analyses.flatMap((analysis) =>
        Object.keys(analysis.tagCounts)
          .filter((key) => key !== "#p" && key !== "#e")
          .sort(),
      ),
    ),
  ).sort();

  return {
    filterCount: Math.max(filters.length, 1),
    kinds: Array.from(new Set(analyses.flatMap((analysis) => analysis.kinds))).sort((a, b) => a - b),
    idsCount: analyses.reduce((sum, analysis) => sum + analysis.idsCount, 0),
    authorsCount: analyses.reduce((sum, analysis) => sum + analysis.authorsCount, 0),
    pTagCount: analyses.reduce((sum, analysis) => sum + (analysis.tagCounts["#p"] ?? 0), 0),
    eTagCount: analyses.reduce((sum, analysis) => sum + (analysis.tagCounts["#e"] ?? 0), 0),
    totalTagValueCount: analyses.reduce((sum, analysis) => sum + Object.values(analysis.tagCounts).reduce((a, b) => a + b, 0), 0),
    otherTagKeys,
    hasSince: analyses.some((analysis) => analysis.hasSince),
    hasUntil: analyses.some((analysis) => analysis.hasUntil),
    hasSearch: analyses.some((analysis) => analysis.hasSearch),
    limit: analyses.length === 1 ? analyses[0].limit : undefined,
  };
}

function buildReqSignature(analyses: ReqFilterAnalysis[]): string {
  return analyses
    .map((analysis) =>
      JSON.stringify({
        i: analysis.filterIndex,
        k: analysis.kinds,
        ids: analysis.idsCount,
        a: analysis.authorsCount,
        t: Object.keys(analysis.tagCounts)
          .sort()
          .map((key) => [key, analysis.tagCounts[key]]),
        s: analysis.hasSince,
        u: analysis.hasUntil,
        q: analysis.hasSearch,
        l: analysis.limit,
      }),
    )
    .join("|");
}

export function analyzeReq(reqPayload: unknown): ReqAnalysis {
  const filters = getReqFilters(reqPayload);
  const analyses = filters.map((reqFilter, filterIndex) => analyzeReqFilter(reqFilter, filterIndex));
  const shape = buildReqShape(filters, analyses);
  const rewriteTargetKinds = new Set(reqRewriteEnabledKinds);
  const candidatePlans = Array.from(new Set(["passthrough", ...analyses.flatMap((analysis) => analysis.rewriteEligibleModes)])) as ReqExecutionStats["mode"][];
  const activeRewriteModes = analyses.some((analysis) => analysis.kinds.some((kind) => rewriteTargetKinds.has(kind)))
    ? candidatePlans.filter((mode) => mode !== "passthrough")
    : [];

  return {
    shape,
    filters: analyses,
    hasMultiFilter: analyses.length > 1,
    hasMultiKindFilter: analyses.some((analysis) => analysis.kinds.length > 1),
    candidatePlans,
    activeRewriteModes,
    signature: buildReqSignature(analyses),
  };
}

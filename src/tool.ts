import { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  registerDataForSeoIntegration,
  resolveDataForSeoCredentials,
} from "./credentials";

const API_URL =
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const DEVICE = "desktop";
const OS = "macos";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_QUERIES = 5;
const DEFAULT_DEPTH = 10;
const DEFAULT_LOCATION = "United States";
const DEFAULT_LANGUAGE = "English";
const HISTORY_VERSION = 1;
const CURRENT_DATE = localDateStamp(new Date());
const OPERATOR_SOURCE =
  "allinanchor|allintext|allintitle|allinurl|define|filetype|id|inanchor|info|intext|intitle|inurl|link|site";

type LocationEntry = { code: number; name: string; iso: string };
type LanguageEntry = { name: string; code: string };

type ReferenceData = {
  locationByName: Map<string, LocationEntry>;
  locationByIso: Map<string, LocationEntry>;
  locationByCode: Map<number, LocationEntry>;
  languageByName: Map<string, LanguageEntry>;
  languageByCode: Map<string, LanguageEntry>;
};

type Credentials = { login: string; password: string };

type NormalizedOrganic = {
  position: number;
  title?: string;
  url: string;
  domain?: string;
  description?: string;
};

type NormalizedReference = {
  url: string;
  source?: string;
  domain?: string;
  title?: string;
  text?: string;
};

type NormalizedAiOverview = {
  text?: string;
  references: NormalizedReference[];
};

type TargetAnnotation = {
  domain: string;
  found: boolean;
  best_position: number | null;
  positions: number[];
  urls: string[];
};

type ResolvedParams = {
  location: string;
  location_code: number;
  language: string;
  language_code: string;
  device: string;
  os: string;
  depth: number;
};

type QueryResult = {
  query: string;
  status: "ok" | "no_results" | "error";
  resolved: ResolvedParams;
  ai_overview?: NormalizedAiOverview;
  organic?: NormalizedOrganic[];
  target?: TargetAnnotation;
  results_count?: number;
  message?: string;
  error?: string;
  cost_usd?: number;
  fetched_at?: string;
};

type CostEntry = {
  timestamp: string;
  query: string;
  location: string;
  language: string;
  depth: number;
  results_count: number;
  status: string;
  cost_usd: number;
};

type HistoryRecord = {
  id: string;
  timestamp: string;
  tool_version: number;
  session_id: string;
  message_id: string;
  agent: string;
  directory: string;
  request: {
    query: string;
    depth: number;
    device: string;
    os: string;
    location: string;
    location_code: number;
    language: string;
    language_code: string;
    target: string | null;
  };
  status: "ok" | "no_results" | "error";
  error: string | null;
  cost: number | null;
  cost_currency: "USD";
  normalized: unknown;
  raw: unknown;
};

type ApiSuccess = { ok: true; body: any };
type ApiFailure = { ok: false; message: string };
type ApiResponse = ApiSuccess | ApiFailure;

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function errorResult(message: string): { content: string } {
  return { content: jsonString({ error: message }) };
}

function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractTask(body: any): any {
  return Array.isArray(body?.tasks) && body.tasks.length > 0
    ? body.tasks[0]
    : body;
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

let referenceDataPromise: Promise<ReferenceData> | undefined;

function loadReferenceData(): Promise<ReferenceData> {
  if (!referenceDataPromise) {
    referenceDataPromise = buildReferenceData().catch((error) => {
      referenceDataPromise = undefined;
      throw error;
    });
  }
  return referenceDataPromise;
}

async function buildReferenceData(): Promise<ReferenceData> {
  const dir = join(PLUGIN_DIR, "..", "data");
  let locations: LocationEntry[];
  let languages: LanguageEntry[];
  try {
    const [locationsRaw, languagesRaw] = await Promise.all([
      readFile(join(dir, "locations.json"), "utf8"),
      readFile(join(dir, "languages.json"), "utf8"),
    ]);
    locations = JSON.parse(locationsRaw) as LocationEntry[];
    languages = JSON.parse(languagesRaw) as LanguageEntry[];
  } catch {
    throw new Error(
      `googlesearch reference data is missing or unreadable. Expected locations.json and languages.json in ${dir}. ` +
        `Deploy them next to the tools directory as described in the googlesearch README.`,
    );
  }
  if (
    !Array.isArray(locations) ||
    locations.length === 0 ||
    !Array.isArray(languages) ||
    languages.length === 0
  ) {
    throw new Error(
      `googlesearch reference data in ${dir} is empty or malformed.`,
    );
  }

  const data: ReferenceData = {
    locationByName: new Map(),
    locationByIso: new Map(),
    locationByCode: new Map(),
    languageByName: new Map(),
    languageByCode: new Map(),
  };
  for (const entry of locations) {
    data.locationByName.set(normalizeKey(entry.name), entry);
    if (entry.iso)
      data.locationByIso.set(entry.iso.trim().toUpperCase(), entry);
    data.locationByCode.set(entry.code, entry);
  }
  for (const entry of languages) {
    data.languageByName.set(normalizeKey(entry.name), entry);
    data.languageByCode.set(entry.code.trim().toLowerCase(), entry);
  }
  return data;
}

function resolveLocation(
  input: unknown,
  data: ReferenceData,
): { ok: true; value: LocationEntry } | { ok: false; error: string } {
  if (
    input === undefined ||
    input === null ||
    (typeof input === "string" && input.trim() === "")
  ) {
    const fallback = data.locationByName.get(normalizeKey(DEFAULT_LOCATION));
    if (!fallback)
      return {
        ok: false,
        error: `Default location "${DEFAULT_LOCATION}" is missing from the reference data.`,
      };
    return { ok: true, value: fallback };
  }

  const raw = String(input).trim();
  if (/^\d+$/.test(raw)) {
    const code = Number(raw);
    const byCode = data.locationByCode.get(code);
    if (byCode) return { ok: true, value: byCode };
    return {
      ok: false,
      error: `Location code ${code} was not found in the supported country list. Use a country name (e.g. "Germany"), an ISO country code (e.g. "DE"), or omit location to default to ${DEFAULT_LOCATION}.`,
    };
  }

  const key = normalizeKey(raw);
  const byName = data.locationByName.get(key);
  if (byName) return { ok: true, value: byName };
  const byIso = data.locationByIso.get(key.toUpperCase());
  if (byIso) return { ok: true, value: byIso };
  return {
    ok: false,
    error:
      `Location "${raw}" was not recognized: country-level locations only (no cities or states). ` +
      `Use a supported country name ("Germany", "United Kingdom"), ISO country code ("DE", "GB"), or DataForSEO numeric code, ` +
      `or omit location for the default "${DEFAULT_LOCATION}". If only a city is known, ask the user which country to use.`,
  };
}

function resolveLanguage(
  input: unknown,
  data: ReferenceData,
): { ok: true; value: LanguageEntry } | { ok: false; error: string } {
  if (
    input === undefined ||
    input === null ||
    (typeof input === "string" && input.trim() === "")
  ) {
    const fallback = data.languageByName.get(normalizeKey(DEFAULT_LANGUAGE));
    if (!fallback)
      return {
        ok: false,
        error: `Default language "${DEFAULT_LANGUAGE}" is missing from the reference data.`,
      };
    return { ok: true, value: fallback };
  }

  const raw = String(input).trim();
  const byName = data.languageByName.get(normalizeKey(raw));
  if (byName) return { ok: true, value: byName };
  const byCode = data.languageByCode.get(raw.toLowerCase());
  if (byCode) return { ok: true, value: byCode };
  return {
    ok: false,
    error:
      `Language "${raw}" was not recognized. Use a supported language name ("English", "German", "Japanese", "Chinese (Simplified)") ` +
      `or language code ("en", "de", "ja", "zh-CN"), or omit language for the default "${DEFAULT_LANGUAGE}".`,
  };
}

function resolveDepth(
  input: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (input === undefined || input === null || input === "")
    return { ok: true, value: DEFAULT_DEPTH };
  const numeric =
    typeof input === "number" ? input : Number(String(input).trim());
  if (
    !Number.isInteger(numeric) ||
    numeric < 10 ||
    numeric > 100 ||
    numeric % 10 !== 0
  ) {
    return {
      ok: false,
      error: `depth must be one of 10, 20, 30, 40, 50, 60, 70, 80, 90, 100 (Google results per query; 10 = first page = 1 SERP; default 10). Received: ${jsonString(input)}.`,
    };
  }
  return { ok: true, value: numeric };
}

function detectOperators(queries: string[]): string[] {
  const pattern = new RegExp(`\\b(?:${OPERATOR_SOURCE}):`, "gi");
  const found = new Set<string>();
  for (const query of queries) {
    for (const match of query.matchAll(pattern)) {
      found.add(match[0].slice(0, -1).toLowerCase());
    }
  }
  return [...found].sort();
}

function buildAuthHeader(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`, "utf8").toString("base64")}`;
}

function buildSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (external && typeof AbortSignal.any === "function")
    return AbortSignal.any([timeout, external]);
  return timeout;
}

async function callLiveApi(
  task: Record<string, unknown>,
  authHeader: string,
  externalAbort?: AbortSignal,
): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: jsonString([task]),
      signal: buildSignal(externalAbort),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError") {
      return {
        ok: false,
        message: `DataForSEO request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The request was NOT retried because every attempt can incur billing.`,
      };
    }
    if (name === "AbortError" && externalAbort?.aborted) {
      return {
        ok: false,
        message: "Search was aborted (session cancelled).",
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `DataForSEO request failed: ${detail}. The request was NOT retried because every attempt can incur billing.`,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      message:
        "DataForSEO rejected the credentials (HTTP 401). Run /connect and choose DataForSEO, or set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD. Do not retry until fixed.",
    };
  }

  let body: any;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const taskPayload = extractTask(body);
  if (
    response.status === 402 ||
    body?.status_code === 40200 ||
    taskPayload?.status_code === 40200
  ) {
    return {
      ok: false,
      message:
        "googlesearch failed: DataForSEO account is out of credits (Payment Required). Tell the user to top up at https://app.dataforseo.com/. Do not retry until topped up.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `DataForSEO returned HTTP ${response.status}${body?.status_message ? `: ${body.status_message}` : ""}.`,
    };
  }
  if (body?.status_code !== 20000) {
    return {
      ok: false,
      message: `DataForSEO error ${body?.status_code ?? "unknown"}: ${body?.status_message ?? "no status message returned"}.`,
    };
  }
  if (
    taskPayload !== body &&
    taskPayload?.status_code !== undefined &&
    taskPayload.status_code !== 20000
  ) {
    return {
      ok: false,
      message: `DataForSEO task error ${taskPayload.status_code}: ${taskPayload.status_message ?? "no status message returned"}.`,
    };
  }
  return { ok: true, body };
}

const TRANSIENT_RETRY_DELAY_MS = 5_000;

function isTransientFailure(message: unknown): boolean {
  return (
    typeof message === "string" &&
    (message.includes("40101") || /HTTP 5\d\d/.test(message))
  );
}

function sleepRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeItems(items: any[]): {
  aiOverview?: NormalizedAiOverview;
  organic: NormalizedOrganic[];
} {
  const organic: NormalizedOrganic[] = [];
  let aiOverview: NormalizedAiOverview | undefined;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "organic" && typeof item.url === "string" && item.url) {
      const entry: NormalizedOrganic = {
        position: Number.isInteger(item.rank_absolute)
          ? item.rank_absolute
          : organic.length + 1,
        url: item.url,
      };
      if (typeof item.title === "string" && item.title.trim())
        entry.title = item.title.trim();
      if (typeof item.domain === "string" && item.domain.trim())
        entry.domain = item.domain.trim();
      if (typeof item.description === "string" && item.description.trim())
        entry.description = item.description.trim();
      organic.push(entry);
      continue;
    }

    if (item.type === "ai_overview") {
      const texts: string[] = [];
      const references = new Map<string, NormalizedReference>();
      const collectReference = (reference: any) => {
        if (!reference || typeof reference !== "object") return;
        if (typeof reference.url !== "string" || !reference.url) return;
        if (references.has(reference.url)) return;
        const entry: NormalizedReference = { url: reference.url };
        if (reference.source) entry.source = String(reference.source);
        if (reference.domain) entry.domain = String(reference.domain);
        if (reference.title) entry.title = String(reference.title);
        if (reference.text) entry.text = String(reference.text);
        references.set(reference.url, entry);
      };
      const walk = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
          for (const child of node) walk(child);
          return;
        }
        if (typeof node !== "object") return;
        if (
          node.type === "ai_overview_element" &&
          typeof node.text === "string" &&
          node.text.trim()
        ) {
          texts.push(node.text.trim());
        }
        if (Array.isArray(node.references)) {
          for (const reference of node.references) collectReference(reference);
        }
        if (Array.isArray(node.items)) walk(node.items);
      };
      walk(item.items);
      if (Array.isArray(item.references)) {
        for (const reference of item.references) collectReference(reference);
      }
      if (texts.length > 0 || references.size > 0) {
        aiOverview = { references: [...references.values()] };
        if (texts.length > 0) aiOverview.text = texts.join("\n\n");
      }
    }
  }

  organic.sort((a, b) => a.position - b.position);
  return { aiOverview, organic };
}

function normalizeTargetDomain(target: string): string {
  return target
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function annotateTarget(
  organic: NormalizedOrganic[],
  target: string,
): TargetAnnotation {
  const wanted = normalizeTargetDomain(target);
  const positions: number[] = [];
  const urls: string[] = [];
  for (const result of organic) {
    let host = "";
    try {
      host = new URL(result.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const bare = host.replace(/^www\./, "");
    if (bare === wanted || bare.endsWith(`.${wanted}`)) {
      positions.push(result.position);
      urls.push(result.url);
    }
  }
  return {
    domain: wanted,
    found: positions.length > 0,
    best_position: positions.length > 0 ? Math.min(...positions) : null,
    positions,
    urls,
  };
}

type HistoryConfig = { enabled: boolean; dir: string };

function historyConfig(
  options: Readonly<Record<string, any>>,
  locationDirectory: string,
): HistoryConfig {
  const flag = process.env.GOOGLESEARCH_HISTORY?.trim().toLowerCase();
  const enabled =
    !(flag === "0" || flag === "false" || flag === "off" || flag === "no") &&
    options.history !== false;

  const configured =
    (typeof options.historyPath === "string" && options.historyPath.trim()) ||
    process.env.GOOGLESEARCH_HISTORY_PATH?.trim();

  const dir = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(locationDirectory, configured)
    : join(
        process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
        "opencode",
        "plugin-data",
        "googlesearch",
      );

  return { enabled, dir };
}

async function writeHistory(
  records: HistoryRecord[],
  dir: string,
): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${localDateStamp(new Date())}.jsonl`);
  const payload = records.map((record) => jsonString(record)).join("\n") + "\n";
  await appendFile(file, payload, "utf8");
}

async function updateCostLog(entries: CostEntry[], dir: string): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(dir, { recursive: true });
  const file = join(dir, "cost-log.json");

  let log: {
    total_cost_usd: number;
    total_searches: number;
    updated_at: string;
    entries: CostEntry[];
  } = {
    total_cost_usd: 0,
    total_searches: 0,
    updated_at: "",
    entries: [],
  };
  let corrupted = false;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && Array.isArray(parsed.entries)) {
      log = {
        total_cost_usd: Number(parsed.total_cost_usd) || 0,
        total_searches: Number(parsed.total_searches) || 0,
        updated_at:
          typeof parsed.updated_at === "string" ? parsed.updated_at : "",
        entries: parsed.entries as CostEntry[],
      };
    } else {
      corrupted = true;
    }
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code !== "ENOENT") corrupted = true;
  }
  if (corrupted) {
    try {
      await rename(file, `${file}.corrupt`);
    } catch {}
  }

  log.entries = [...entries, ...log.entries];
  log.total_searches = log.entries.length;
  log.total_cost_usd = round6(
    log.entries.reduce((sum, entry) => sum + (Number(entry.cost_usd) || 0), 0),
  );
  log.updated_at = new Date().toISOString();

  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(log, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export default Plugin.define({
  id: "opencode-googlesearch",
  async setup(ctx) {
    await registerDataForSeoIntegration(ctx);
    const locationDirectory = ctx.location.directory;
    const history = historyConfig(ctx.options, locationDirectory);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "googlesearch",
        description: `Search Google and return fresh, real-time SERP results. Use when the answer may depend on current information — news, releases, announcements, prices, events, fact checks, anything possibly newer than your training data — or when you need to see what Google currently returns for a query.`,

        input: {
          type: "object",
          properties: {
            queries: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 700 },
              minItems: 1,
              maxItems: MAX_QUERIES,
              description: `1 to ${MAX_QUERIES} Google search queries, run in parallel. Today is ${CURRENT_DATE} — keep queries current, never search with stale years. Be strategic: one well-crafted query is usually enough; add more only when they genuinely add value, never reworded copies of the same question. If results aren't enough, think about why and refine your search instead of repeating similar ones. site: works inside a query if needed. Format: a plain array of strings only, e.g. ["iphone 17 price", "pixel 11 review"] — never objects like {"query": "..."}, never one stringified array. If only a search term is needed, pass just the queries and leave location/language out; the defaults apply.`,
            },
            depth: {
              anyOf: [{ type: "number" }, { type: "string" }],
              description:
                "Google results per query: 10 (default, first page) up to 100, in steps of 10. Billing is per 10 results, so only raise depth when more results are genuinely needed.",
            },
            location: {
              anyOf: [{ type: "string" }, { type: "number" }],
              description:
                'Country-level Google location: country name ("Germany"), ISO country code ("DE"), or DataForSEO numeric code ("2276"). Cities and regions are NOT supported. Default: "United States". Only set this when the user request is tied to a country (e.g. "in Japan", "Japanese market", prices in yen) — then pass the plain country name like "Japan". If no country is implied, do not send it.',
            },
            language: {
              type: "string",
              description:
                'Google interface language: name ("Japanese") or code ("ja", "zh-CN"). Default: "English". Only set this when the user wants results in a specific language (e.g. "Japanese news") — write the query text in that language too. Otherwise do not send it.',
            },
            target: {
              type: "string",
              description:
                'Optional domain to watch for in the results (e.g. "example.com"). The tool reports whether and where it appears (found, best_position, positions, urls). It does not restrict the search.',
            },
          },
          required: ["queries"],
          additionalProperties: false,
        },
        options: { codemode: false },

        async execute(rawArgs, context) {
          const args = rawArgs as {
            queries: string[];
            depth?: number | string;
            location?: string | number;
            language?: string;
            target?: string;
          };
          let credentials: Credentials;
          try {
            credentials = await resolveDataForSeoCredentials(ctx);
          } catch (error) {
            return errorResult(
              error instanceof Error ? error.message : String(error),
            );
          }

          let data: ReferenceData;
          try {
            data = await loadReferenceData();
          } catch (error) {
            return errorResult(
              error instanceof Error ? error.message : String(error),
            );
          }

          const depth = resolveDepth(args.depth);
          if (!depth.ok) return errorResult(depth.error);

          const location = resolveLocation(args.location, data);
          if (!location.ok) return errorResult(location.error);

          const language = resolveLanguage(args.language, data);
          if (!language.ok) return errorResult(language.error);

          const trimmed: string[] = [];
          for (const query of args.queries) {
            const candidate = typeof query === "string" ? query.trim() : "";
            if (candidate) trimmed.push(candidate);
          }
          if (trimmed.length === 0) {
            return errorResult(
              "queries must contain at least one non-empty search string.",
            );
          }
          const unique: string[] = [];
          const duplicates: string[] = [];
          const seen = new Map<string, string>();
          for (const query of trimmed) {
            const key = query.toLowerCase();
            if (seen.has(key)) duplicates.push(query);
            else {
              seen.set(key, query);
              unique.push(query);
            }
          }

          const notes: string[] = [];
          if (duplicates.length > 0) {
            notes.push(
              `Duplicate queries were deduplicated and executed once: ${duplicates.map((d) => jsonString(d)).join(", ")}.`,
            );
          }
          const operators = detectOperators(unique);
          if (operators.length > 0) {
            notes.push(
              `Google operator(s) detected: ${operators.map((operator) => `${operator}:`).join(", ")} — DataForSEO bills each operator at 5x the base SERP price.`,
            );
          }

          const resolved: ResolvedParams = {
            location: location.value.name,
            location_code: location.value.code,
            language: language.value.name,
            language_code: language.value.code,
            device: DEVICE,
            os: OS,
            depth: depth.value,
          };
          const target =
            typeof args.target === "string" && args.target.trim()
              ? args.target.trim()
              : undefined;

          const authHeader = buildAuthHeader(credentials);
          const responses = await Promise.allSettled(
            unique.map((keyword) =>
              callLiveApi(
                {
                  keyword,
                  location_code: location.value.code,
                  language_code: language.value.code,
                  device: DEVICE,
                  os: OS,
                  depth: depth.value,
                },
                authHeader,
                context.signal,
              ),
            ),
          );

          // Retry transient SE-side failures (40101 / HTTP 5xx) exactly once after a pause.
          // DataForSEO bills $0 for failed tasks, so a retry costs nothing unless it recovers.
          const retryIndexes: number[] = [];
          responses.forEach((settled, index) => {
            if (
              settled.status === "fulfilled" &&
              !settled.value.ok &&
              isTransientFailure(settled.value.message)
            )
              retryIndexes.push(index);
          });
          if (retryIndexes.length > 0 && !context.signal.aborted) {
            await sleepRetry(TRANSIENT_RETRY_DELAY_MS);
            const retries = await Promise.allSettled(
              retryIndexes.map((index) =>
                callLiveApi(
                  {
                    keyword: unique[index],
                    location_code: location.value.code,
                    language_code: language.value.code,
                    device: DEVICE,
                    os: OS,
                    depth: depth.value,
                  },
                  authHeader,
                  context.signal,
                ),
              ),
            );
            let recovered = 0;
            retryIndexes.forEach((index, slot) => {
              const retry = retries[slot];
              if (retry.status === "fulfilled" && retry.value.ok) {
                responses[index] = retry;
                recovered += 1;
                return;
              }
              const first = responses[index];
              const baseMessage =
                retry.status === "fulfilled" && !retry.value.ok
                  ? retry.value.message
                  : first.status === "fulfilled" && !first.value.ok
                    ? first.value.message
                    : "Search failed.";
              responses[index] = {
                status: "fulfilled",
                value: {
                  ok: false,
                  message: `${baseMessage} Search failed after 1 retry.`,
                },
              };
            });
            notes.push(
              `Retried ${retryIndexes.length} transiently failed query(ies) once after 5s; ${recovered} recovered.`,
            );
          }

          const searches: QueryResult[] = [];
          const historyRecords: HistoryRecord[] = [];
          const costEntries: CostEntry[] = [];
          let executed = 0;
          let totalCost = 0;
          let totalResults = 0;

          unique.forEach((keyword, index) => {
            const settled = responses[index];
            const timestamp = new Date().toISOString();
            const historyBase = {
              id: `${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp,
              tool_version: HISTORY_VERSION,
              session_id: String(context.sessionID ?? ""),
              message_id: String(context.messageID ?? ""),
              agent: String(context.agent ?? ""),
              directory: locationDirectory,
              request: {
                query: keyword,
                depth: depth.value,
                device: DEVICE,
                os: OS,
                location: location.value.name,
                location_code: location.value.code,
                language: language.value.name,
                language_code: language.value.code,
                target: target ?? null,
              },
            };
            const costBase = {
              timestamp,
              query: keyword,
              location: location.value.name,
              language: language.value.name,
              depth: depth.value,
            };

            if (settled.status === "rejected") {
              const message = `Unexpected internal error: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`;
              searches.push({
                query: keyword,
                status: "error",
                resolved,
                error: message,
              });
              historyRecords.push({
                ...historyBase,
                status: "error",
                error: message,
                cost: null,
                cost_currency: "USD",
                normalized: null,
                raw: null,
              });
              costEntries.push({
                ...costBase,
                results_count: 0,
                status: "error",
                cost_usd: 0,
              });
              return;
            }

            const response = settled.value;
            if (!response.ok) {
              searches.push({
                query: keyword,
                status: "error",
                resolved,
                error: response.message,
              });
              historyRecords.push({
                ...historyBase,
                status: "error",
                error: response.message,
                cost: null,
                cost_currency: "USD",
                normalized: null,
                raw: null,
              });
              costEntries.push({
                ...costBase,
                results_count: 0,
                status: "error",
                cost_usd: 0,
              });
              return;
            }

            executed += 1;
            const body = response.body;
            const task = extractTask(body);
            const cost =
              typeof body?.cost === "number"
                ? body.cost
                : typeof task?.cost === "number"
                  ? task.cost
                  : null;
            if (cost !== null) totalCost += cost;
            const taskResult = Array.isArray(task?.result)
              ? task.result[0]
              : undefined;
            const items = Array.isArray(taskResult?.items)
              ? taskResult.items
              : [];
            const normalized = normalizeItems(items);
            const fetchedAt =
              typeof taskResult?.datetime === "string"
                ? taskResult.datetime
                : undefined;

            if (normalized.organic.length === 0 && !normalized.aiOverview) {
              const message = `No search results found for your query: "${keyword}".`;
              searches.push({
                query: keyword,
                status: "no_results",
                resolved,
                message,
                results_count: 0,
                cost_usd: cost ?? undefined,
                fetched_at: fetchedAt,
              });
              historyRecords.push({
                ...historyBase,
                status: "no_results",
                error: null,
                cost,
                cost_currency: "USD",
                normalized: { ai_overview: null, organic: [] },
                raw: body,
              });
              costEntries.push({
                ...costBase,
                results_count: 0,
                status: "no_results",
                cost_usd: cost ?? 0,
              });
              return;
            }

            const result: QueryResult = {
              query: keyword,
              status: "ok",
              resolved,
              organic: normalized.organic,
              results_count: normalized.organic.length,
            };
            if (normalized.aiOverview)
              result.ai_overview = normalized.aiOverview;
            if (target)
              result.target = annotateTarget(normalized.organic, target);
            if (cost !== null) result.cost_usd = cost;
            if (fetchedAt) result.fetched_at = fetchedAt;
            searches.push(result);
            totalResults += normalized.organic.length;

            historyRecords.push({
              ...historyBase,
              status: "ok",
              error: null,
              cost,
              cost_currency: "USD",
              normalized: {
                ai_overview: normalized.aiOverview ?? null,
                organic: normalized.organic,
                target: result.target ?? null,
              },
              raw: body,
            });
            costEntries.push({
              ...costBase,
              results_count: normalized.organic.length,
              status: "ok",
              cost_usd: cost ?? 0,
            });
          });

          if (history.enabled) {
            try {
              await writeHistory(historyRecords, history.dir);
              await updateCostLog(costEntries, history.dir);
            } catch (error) {
              notes.push(
                `Search completed, but local history could not be saved: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          return {
            content: jsonString({
              searches,
              totals: {
                queries_requested: Array.isArray(args.queries)
                  ? args.queries.length
                  : 0,
                queries_executed: executed,
                results: totalResults,
                cost_usd: round6(totalCost),
              },
              ...(notes.length > 0 ? { notes } : {}),
            }),
          };
        },
      });
    });
  },
});

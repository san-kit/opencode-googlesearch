import { Plugin } from "@opencode/plugin";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  registerDataForSeoIntegration,
  resolveDataForSeoCredentials,
} from "./credentials.ts";

const API_URL =
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const DEVICE = "desktop";
const OS = "macos";
const REQUEST_TIMEOUT_MS = 60_000;
// resolve_goto_urls adds roughly 40-60s; DataForSEO caps total turnaround at 260s.
const RESOLVE_GOTO_TIMEOUT_MS = 300_000;
const MAX_QUERIES = 5;
const MAX_QUERY_LENGTH = 700;
const MAX_DEPTH = 100;
const DEFAULT_DEPTH = 10;
const DEFAULT_LOCATION = "United States";
const DEFAULT_LANGUAGE = "English";
const HISTORY_VERSION = 1;
const HISTORY_RETENTION_DAYS = 30;
const MAX_COST_LOG_ENTRIES = 10_000;
const OPERATOR_SOURCE =
  "allinanchor|allintext|allintitle|allinurl|cache|define|definition|filetype|inanchor|intext|intitle|inurl|link|site";
const AMBIGUOUS_OPERATOR_SOURCE = "id|info";
// DataForSEO status codes: https://docs.dataforseo.com/v3/appendix/errors/
// 40200 Payment Required, 40210 insufficient funds.
const OUT_OF_CREDITS_CODES = new Set<unknown>([40200, 40210]);
// 40101 internal SE server error, 40103 task execution failed (resubmit).
const TRANSIENT_TASK_CODES = new Set<unknown>([40101, 40103]);
const NO_RESULTS_CODE = 40102;

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
  resolve_goto_urls: boolean;
  load_async_ai_overview: boolean;
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
  duration_ms?: number;
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
    resolve_goto_urls: boolean;
    load_async_ai_overview: boolean;
  };
  status: "ok" | "no_results" | "error";
  error: string | null;
  cost: number | null;
  cost_currency: "USD";
  duration_ms: number;
  normalized: unknown;
  raw: unknown;
};

type ApiSuccess = { ok: true; body: any };
type ApiFailure = { ok: false; message: string; transient?: boolean };
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

function hostFromUrl(value: string): string | undefined {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

function isGoogleRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!/(^|\.)google\.[a-z.]+$/.test(url.hostname.toLowerCase()))
      return false;
    return url.pathname.startsWith("/goto") || url.pathname.startsWith("/url");
  } catch {
    return false;
  }
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
        `Reinstall the plugin package; the data directory ships with it.`,
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
  allowedMax: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (input === undefined || input === null || input === "")
    return { ok: true, value: DEFAULT_DEPTH };
  const numeric =
    typeof input === "number" ? input : Number(String(input).trim());
  if (
    !Number.isInteger(numeric) ||
    numeric < 10 ||
    numeric > allowedMax ||
    numeric % 10 !== 0
  ) {
    const allowed = Array.from(
      { length: allowedMax / 10 },
      (_, index) => (index + 1) * 10,
    ).join(", ");
    return {
      ok: false,
      error: `depth must be one of ${allowed} (Google results per query; 10 = first page = 1 SERP; default 10; configured maximum ${allowedMax}). Received: ${jsonString(input)}.`,
    };
  }
  return { ok: true, value: numeric };
}

function detectOperators(queries: string[]): string[] {
  const pattern = new RegExp(`\\b(?:${OPERATOR_SOURCE}):`, "gi");
  // info: and id: are also ordinary English words ("contact info:"), so only
  // count them when they appear as the leading operator of the query.
  const leadingPattern = new RegExp(`^(?:${AMBIGUOUS_OPERATOR_SOURCE}):`, "i");
  const found = new Set<string>();
  for (const query of queries) {
    for (const match of query.matchAll(pattern)) {
      found.add(match[0].slice(0, -1).toLowerCase());
    }
    const leading = query.match(leadingPattern);
    if (leading) found.add(leading[0].slice(0, -1).toLowerCase());
  }
  return [...found].sort();
}

function buildAuthHeader(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`, "utf8").toString("base64")}`;
}

function buildSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (external && typeof AbortSignal.any === "function")
    return AbortSignal.any([timeout, external]);
  return timeout;
}

async function callLiveApi(
  task: Record<string, unknown>,
  authHeader: string,
  timeoutMs: number,
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
      redirect: "error",
      signal: buildSignal(timeoutMs, externalAbort),
    });
  } catch (error) {
    // Check the session signal first: it may abort with a custom reason whose
    // name is neither AbortError nor TimeoutError.
    if (externalAbort?.aborted) {
      return {
        ok: false,
        message: "Search was aborted (session cancelled).",
      };
    }
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError") {
      return {
        ok: false,
        message: `DataForSEO request timed out after ${timeoutMs / 1000}s. The request was NOT retried because every attempt can incur billing.`,
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
    OUT_OF_CREDITS_CODES.has(body?.status_code) ||
    OUT_OF_CREDITS_CODES.has(taskPayload?.status_code)
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
      transient: response.status >= 500,
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
    taskPayload.status_code !== 20000 &&
    // 40102 "No Search Results" is a valid empty SERP, reported as no_results.
    taskPayload.status_code !== NO_RESULTS_CODE
  ) {
    return {
      ok: false,
      message: `DataForSEO task error ${taskPayload.status_code}: ${taskPayload.status_message ?? "no status message returned"}.`,
      transient: TRANSIENT_TASK_CODES.has(taskPayload.status_code),
    };
  }
  return { ok: true, body };
}

const TRANSIENT_RETRY_DELAY_MS = 5_000;

function sleepRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(new Error("Search was aborted (session cancelled)."));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolveSleep();
    }, ms);
    const onAbort = () => {
      cleanup();
      rejectSleep(new Error("Search was aborted (session cancelled)."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
      const reportedDomain =
        typeof item.domain === "string" && item.domain.trim()
          ? item.domain.trim()
          : undefined;
      const host = hostFromUrl(item.url);
      const reportedIsGoogle =
        reportedDomain?.toLowerCase().replace(/^www\./, "") === "google.com";
      // Older responses sometimes leave domain as google.com after resolving
      // the url; derive it from the final URL in that case.
      if (
        host &&
        host !== "google.com" &&
        (!reportedDomain || reportedIsGoogle)
      )
        entry.domain = host;
      else if (reportedDomain) entry.domain = reportedDomain;
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
    .split(/[/?#:]/)[0];
}

function annotateTarget(
  organic: NormalizedOrganic[],
  target: string,
): TargetAnnotation {
  const wanted = normalizeTargetDomain(target);
  const positions: number[] = [];
  const urls: string[] = [];
  for (const result of organic) {
    const host = hostFromUrl(result.url);
    if (!host) continue;
    if (host === wanted || host.endsWith(`.${wanted}`)) {
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

type HistoryConfig = {
  enabled: boolean;
  dir: string;
  // Only the plugin-owned default directory is chmod-ed when it already
  // exists; a configured path may point at a directory the user shares.
  ownsDir: boolean;
  raw: boolean;
  retentionDays: number;
  warning?: string;
};

type SearchConfig = {
  resolveGotoUrls: boolean;
  aiOverview: boolean;
  maxDepth: number;
  timeoutMs: number;
};

function booleanSetting(
  envValue: string | undefined,
  option: unknown,
  fallback: boolean,
): boolean {
  const flag = envValue?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes")
    return true;
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no")
    return false;
  return typeof option === "boolean" ? option : fallback;
}

function integerSetting(
  envValue: string | undefined,
  option: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw =
    envValue?.trim() ||
    (typeof option === "number"
      ? String(option)
      : typeof option === "string"
        ? option.trim()
        : "");
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function searchConfig(options: Readonly<Record<string, any>>): SearchConfig {
  // Goto links are opaque tokens, so they can only be resolved by DataForSEO.
  // Default to on: without it most result URLs are unusable google.com redirects.
  const resolveGotoUrls = booleanSetting(
    process.env.GOOGLESEARCH_RESOLVE_GOTO_URLS,
    options.resolveGotoUrls,
    true,
  );
  const aiOverview = booleanSetting(
    process.env.GOOGLESEARCH_AI_OVERVIEW,
    options.aiOverview,
    false,
  );
  // maxDepth is a billing cap, so out-of-range numbers are clamped rather than
  // falling back to the most expensive value.
  const rawMaxDepth = Number(
    process.env.GOOGLESEARCH_MAX_DEPTH?.trim() || options.maxDepth,
  );
  const maxDepth = Number.isFinite(rawMaxDepth)
    ? Math.min(
        MAX_DEPTH,
        Math.max(DEFAULT_DEPTH, Math.floor(rawMaxDepth / 10) * 10),
      )
    : MAX_DEPTH;
  return {
    resolveGotoUrls,
    aiOverview,
    maxDepth,
    timeoutMs: resolveGotoUrls ? RESOLVE_GOTO_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  };
}

function defaultHistoryDir(): string {
  return join(
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
    "opencode",
    "plugin-data",
    "googlesearch",
  );
}

function historyConfig(options: Readonly<Record<string, any>>): HistoryConfig {
  // Environment variables consistently take precedence over plugin options.
  const enabled = booleanSetting(
    process.env.GOOGLESEARCH_HISTORY,
    options.history,
    true,
  );
  const raw = booleanSetting(
    process.env.GOOGLESEARCH_HISTORY_RAW,
    options.historyRaw,
    false,
  );
  const retentionDays = integerSetting(
    process.env.GOOGLESEARCH_HISTORY_RETENTION_DAYS,
    options.historyRetentionDays,
    HISTORY_RETENTION_DAYS,
    0,
    3650,
  );

  const configured =
    process.env.GOOGLESEARCH_HISTORY_PATH?.trim() ||
    (typeof options.historyPath === "string" ? options.historyPath.trim() : "");

  let dir = defaultHistoryDir();
  let ownsDir = true;
  let warning: string | undefined;
  if (configured) {
    if (isAbsolute(configured)) {
      dir = configured;
      ownsDir = false;
    } else {
      // A relative path would resolve against the server's working directory,
      // which is often the repository itself.
      warning = `historyPath ${jsonString(configured)} was ignored: only absolute paths are allowed, so history is written to ${dir}.`;
    }
  }

  return { enabled, dir, ownsDir, raw, retentionDays, warning };
}

async function ensureSecureDir(history: HistoryConfig): Promise<void> {
  // Newly created directories get 0700 from mkdir.
  const created = await mkdir(history.dir, { recursive: true, mode: 0o700 });
  if (created !== undefined || !history.ownsDir) return;
  try {
    await chmod(history.dir, 0o700);
  } catch {}
}

const HISTORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

async function pruneHistory(dir: string, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoff = localDateStamp(
    new Date(Date.now() - retentionDays * 86_400_000),
  );
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoffFile = `${cutoff}.jsonl`;
  await Promise.all(
    names
      .filter((name) => HISTORY_FILE_PATTERN.test(name) && name < cutoffFile)
      .map((name) => unlink(join(dir, name)).catch(() => {})),
  );
}

async function writeHistory(
  records: HistoryRecord[],
  history: HistoryConfig,
): Promise<void> {
  if (records.length === 0) return;
  await ensureSecureDir(history);
  const file = join(history.dir, `${localDateStamp(new Date())}.jsonl`);
  const payload = records.map((record) => jsonString(record)).join("\n") + "\n";
  await appendFile(file, payload, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {}
  await pruneHistory(history.dir, history.retentionDays);
}

const costLogQueues = new Map<string, Promise<void>>();

// Serialize read-modify-write cycles per history directory. Without this,
// parallel tool calls in one server process overwrite each other's entries.
function updateCostLog(
  entries: CostEntry[],
  history: HistoryConfig,
): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  const file = join(history.dir, "cost-log.json");
  const previous = costLogQueues.get(file) ?? Promise.resolve();
  const next = previous.then(() => updateCostLogNow(entries, history));
  costLogQueues.set(
    file,
    next.catch(() => {}),
  );
  return next;
}

async function updateCostLogNow(
  entries: CostEntry[],
  history: HistoryConfig,
): Promise<void> {
  await ensureSecureDir(history);
  const file = join(history.dir, "cost-log.json");

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
      const storedEntries = parsed.entries as CostEntry[];
      log = {
        total_cost_usd: Number(parsed.total_cost_usd) || 0,
        total_searches: Number.isInteger(parsed.total_searches)
          ? parsed.total_searches
          : storedEntries.length,
        updated_at:
          typeof parsed.updated_at === "string" ? parsed.updated_at : "",
        entries: storedEntries,
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

  const addedCost = entries.reduce(
    (sum, entry) => sum + (Number(entry.cost_usd) || 0),
    0,
  );
  log.total_searches += entries.length;
  log.total_cost_usd = round6(log.total_cost_usd + addedCost);
  // Entries contain query text, so they follow the history retention window.
  // The totals stay cumulative.
  const cutoff =
    history.retentionDays > 0
      ? Date.now() - history.retentionDays * 86_400_000
      : -Infinity;
  log.entries = [...entries, ...log.entries]
    .filter((entry) => !(Date.parse(entry?.timestamp) < cutoff))
    .slice(0, MAX_COST_LOG_ENTRIES);
  log.updated_at = new Date().toISOString();

  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(log, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, file);
  try {
    await chmod(file, 0o600);
  } catch {}
}

export default Plugin.define({
  id: "opencode-googlesearch",
  async setup(ctx) {
    await registerDataForSeoIntegration(ctx);
    const locationDirectory = ctx.location.directory;
    const history = historyConfig(ctx.options);
    const search = searchConfig(ctx.options);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "googlesearch",
        description: `Search Google and return fresh, real-time SERP results. Use when the answer may depend on current information — news, releases, announcements, prices, events, fact checks, anything possibly newer than your training data — or when you need to see what Google currently returns for a query.`,

        input: {
          type: "object",
          properties: {
            queries: {
              type: "array",
              items: {
                type: "string",
                minLength: 1,
                maxLength: MAX_QUERY_LENGTH,
              },
              minItems: 1,
              maxItems: MAX_QUERIES,
              description: `1 to ${MAX_QUERIES} Google search queries, run in parallel. Keep queries current; never search with stale years. Be strategic: one well-crafted query is usually enough; add more only when they genuinely add value, never reworded copies of the same question. If results aren't enough, think about why and refine your search instead of repeating similar ones. site: works inside a query if needed. Format: a plain array of strings only, e.g. ["iphone 17 price", "pixel 11 review"] — never objects like {"query": "..."}, never one stringified array. If only a search term is needed, pass just the queries and leave location/language out; the defaults apply.`,
            },
            depth: {
              anyOf: [{ type: "number" }, { type: "string" }],
              description: `Google results per query: 10 (default, first page) up to ${search.maxDepth}, in steps of 10. Billing is per 10 results, so only raise depth when more results are genuinely needed.`,
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
        options: { codemode: false, permission: "googlesearch" },

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

          const depth = resolveDepth(args.depth, search.maxDepth);
          if (!depth.ok) return errorResult(depth.error);

          const location = resolveLocation(args.location, data);
          if (!location.ok) return errorResult(location.error);

          const language = resolveLanguage(args.language, data);
          if (!language.ok) return errorResult(language.error);

          if (!Array.isArray(args.queries)) {
            return errorResult("queries must be an array of search strings.");
          }
          if (args.queries.length > MAX_QUERIES) {
            return errorResult(
              `queries accepts at most ${MAX_QUERIES} queries per call (received ${args.queries.length}). Split the searches into multiple calls instead.`,
            );
          }
          const trimmed: string[] = [];
          for (const query of args.queries) {
            const candidate = typeof query === "string" ? query.trim() : "";
            if (!candidate) continue;
            if (candidate.length > MAX_QUERY_LENGTH) {
              return errorResult(
                `Query is ${candidate.length} characters long; DataForSEO accepts at most ${MAX_QUERY_LENGTH} characters per query. Shorten the query and try again.`,
              );
            }
            trimmed.push(candidate);
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
          if (history.enabled && history.warning) notes.push(history.warning);
          if (duplicates.length > 0) {
            notes.push(
              `Duplicate queries were deduplicated and executed once: ${duplicates.map((d) => jsonString(d)).join(", ")}.`,
            );
          }
          const operators = detectOperators(unique);
          if (operators.length > 0) {
            notes.push(
              `Google operator(s) detected: ${operators.map((operator) => `${operator}:`).join(", ")} — DataForSEO multiplies the whole task price by 5 when a query contains one or more of these operators.`,
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
            resolve_goto_urls: search.resolveGotoUrls,
            load_async_ai_overview: search.aiOverview,
          };
          const target =
            typeof args.target === "string" && args.target.trim()
              ? args.target.trim()
              : undefined;

          // options.permission only hides the tool on a blanket deny; ask
          // rules and per-query rules are enforced here. Rejections propagate.
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: {
              type: "tool",
              messageID: context.messageID,
              id: context.id,
            },
            action: "googlesearch",
            resources: unique,
            save: ["*"],
            metadata: {
              queries: unique,
              depth: depth.value,
              location: location.value.name,
              language: language.value.name,
            },
          });

          const authHeader = buildAuthHeader(credentials);
          const buildTask = (keyword: string): Record<string, unknown> => ({
            keyword,
            location_code: location.value.code,
            language_code: language.value.code,
            device: DEVICE,
            os: OS,
            depth: depth.value,
            resolve_goto_urls: search.resolveGotoUrls,
            ...(search.aiOverview ? { load_async_ai_overview: true } : {}),
          });
          const batchStartedAt = Date.now();
          // Per-query request time in ms, summed over the first attempt and
          // any retry; the retry wait is excluded.
          const queryDurations = new Map<number, number>();
          const timed = async (index: number): Promise<ApiResponse> => {
            const startedAt = Date.now();
            try {
              return await callLiveApi(
                buildTask(unique[index]),
                authHeader,
                search.timeoutMs,
                context.signal,
              );
            } finally {
              queryDurations.set(
                index,
                (queryDurations.get(index) ?? 0) + Date.now() - startedAt,
              );
            }
          };
          const responses = await Promise.allSettled(
            unique.map((_, index) => timed(index)),
          );

          // Retry transient failures (HTTP 5xx, task 40101/40103) exactly once after a pause.
          // DataForSEO bills $0 for failed tasks, so a retry costs nothing unless it recovers.
          const retryIndexes: number[] = [];
          responses.forEach((settled, index) => {
            if (
              settled.status === "fulfilled" &&
              !settled.value.ok &&
              settled.value.transient
            )
              retryIndexes.push(index);
          });
          if (retryIndexes.length > 0) {
            let retryAllowed = !context.signal.aborted;
            if (retryAllowed) {
              try {
                await sleepRetry(TRANSIENT_RETRY_DELAY_MS, context.signal);
              } catch {
                retryAllowed = false;
              }
            }
            if (!retryAllowed) {
              notes.push(
                "Retry skipped because the search was cancelled. DataForSEO may still bill the original request.",
              );
            } else {
              const retries = await Promise.allSettled(
                retryIndexes.map((index) => timed(index)),
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
          }

          const searches: QueryResult[] = [];
          const historyRecords: HistoryRecord[] = [];
          const costEntries: CostEntry[] = [];
          let executed = 0;
          let totalCost = 0;
          let totalResults = 0;
          let unresolvedRedirects = 0;

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
                resolve_goto_urls: search.resolveGotoUrls,
                load_async_ai_overview: search.aiOverview,
              },
            };
            const costBase = {
              timestamp,
              query: keyword,
              location: location.value.name,
              language: language.value.name,
              depth: depth.value,
            };
            const durationMs = queryDurations.get(index) ?? 0;

            if (settled.status === "rejected") {
              const message = `Unexpected internal error: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`;
              searches.push({
                query: keyword,
                status: "error",
                resolved,
                error: message,
                duration_ms: durationMs,
              });
              historyRecords.push({
                ...historyBase,
                duration_ms: durationMs,
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
                duration_ms: durationMs,
              });
              historyRecords.push({
                ...historyBase,
                duration_ms: durationMs,
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
            if (search.resolveGotoUrls)
              unresolvedRedirects += normalized.organic.filter((item) =>
                isGoogleRedirectUrl(item.url),
              ).length;
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
                duration_ms: durationMs,
              });
              historyRecords.push({
                ...historyBase,
                duration_ms: durationMs,
                status: "no_results",
                error: null,
                cost,
                cost_currency: "USD",
                normalized: { ai_overview: null, organic: [] },
                raw: history.raw ? body : null,
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
              duration_ms: durationMs,
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
              duration_ms: durationMs,
              status: "ok",
              error: null,
              cost,
              cost_currency: "USD",
              normalized: {
                ai_overview: normalized.aiOverview ?? null,
                organic: normalized.organic,
                target: result.target ?? null,
              },
              raw: history.raw ? body : null,
            });
            costEntries.push({
              ...costBase,
              results_count: normalized.organic.length,
              status: "ok",
              cost_usd: cost ?? 0,
            });
          });

          if (search.resolveGotoUrls && unresolvedRedirects > 0) {
            notes.push(
              `${unresolvedRedirects} result URL(s) were still Google redirect links after goto resolution; DataForSEO returned the original URL when a redirect could not be resolved.`,
            );
          }

          if (history.enabled) {
            try {
              await writeHistory(historyRecords, history);
              await updateCostLog(costEntries, history);
            } catch (error) {
              notes.push(
                `Search completed, but local history could not be saved: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          const today = localDateStamp(new Date());
          return {
            content: jsonString({
              today,
              searches,
              totals: {
                queries_requested: args.queries.length,
                queries_executed: executed,
                results: totalResults,
                cost_usd: round6(totalCost),
                duration_ms: Date.now() - batchStartedAt,
              },
              ...(notes.length > 0 ? { notes } : {}),
            }),
          };
        },
      });
    });
  },
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import plugin from "../src/tool.ts";

type FetchCall = { url: string; task: Record<string, unknown> };
type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
  index: number,
) => Response | Promise<Response>;

function setEnv(
  t: { after: (fn: () => void) => void },
  values: Record<string, string | undefined>,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function okBody(items: unknown[], cost = 0.002): unknown {
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost,
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        cost,
        result: [
          {
            datetime: "2026-11-19 00:00:00 +00:00",
            items,
          },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetchHandler(handler: FetchHandler): {
  calls: FetchCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const index = calls.length;
    calls.push({
      url: String(url),
      task: JSON.parse(String(init?.body))[0],
    });
    return handler(String(url), init, index);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function installFetch(items: unknown[]): {
  calls: FetchCall[];
  restore: () => void;
} {
  return installFetchHandler(() => jsonResponse(okBody(items)));
}

async function loadTool(
  options: Record<string, unknown> = {},
  assertPermission: (input: any) => Promise<void> = async () => {},
): Promise<any> {
  let definition: any;
  const ctx = {
    options,
    location: { directory: "/tmp/googlesearch-test" },
    permission: { assert: assertPermission },
    integration: {
      transform: async (fn: any) =>
        fn({
          update: (_id: string, update: any) => update({}),
          method: { update: () => {} },
        }),
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    tool: {
      transform: async (fn: any) =>
        fn({
          add: (tool: any) => {
            definition = tool;
          },
        }),
    },
  } as unknown as Plugin.Context;
  await plugin.setup(ctx);
  return definition;
}

function toolContext(signal = new AbortController().signal): any {
  return {
    signal,
    sessionID: "ses_test",
    messageID: "msg_test",
    id: "call_test",
    agent: "test",
    progress: async () => {},
  };
}

async function tempDir(t: {
  after: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "googlesearch-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const baseEnv = {
  DATAFORSEO_LOGIN: "test-login",
  DATAFORSEO_PASSWORD: "test-password",
  GOOGLESEARCH_HISTORY: "0",
  GOOGLESEARCH_HISTORY_PATH: undefined,
  GOOGLESEARCH_HISTORY_RAW: undefined,
  GOOGLESEARCH_HISTORY_RETENTION_DAYS: undefined,
  GOOGLESEARCH_RESOLVE_GOTO_URLS: undefined,
  GOOGLESEARCH_AI_OVERVIEW: undefined,
  GOOGLESEARCH_MAX_DEPTH: undefined,
  XDG_DATA_HOME: undefined,
};

test("googlesearch: resolves goto URLs by default", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([
    {
      type: "organic",
      rank_absolute: 1,
      url: "https://www.example.com/page",
      domain: "google.com",
      title: "Example",
      description: "Example result",
    },
    {
      type: "organic",
      rank_absolute: 2,
      url: "https://google.com/goto?url=abc",
      domain: "google.com",
      title: "Unresolved",
    },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute(
    { queries: ["final urls"], target: "example.com" },
    toolContext(),
  );
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.equal(
    network.calls[0].url,
    "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
  );
  assert.equal(network.calls[0].task.resolve_goto_urls, true);
  assert.equal(network.calls[0].task.keyword, "final urls");

  assert.match(output.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(output.searches[0].resolved.resolve_goto_urls, true);
  assert.equal(output.searches[0].organic[0].domain, "example.com");
  assert.equal(output.searches[0].organic[1].domain, "google.com");
  assert.equal(typeof output.searches[0].duration_ms, "number");
  assert.deepEqual(output.searches[0].target, {
    domain: "example.com",
    found: true,
    best_position: 1,
    positions: [1],
    urls: ["https://www.example.com/page"],
  });
  assert.match(output.notes[0], /still Google redirect links/);
});

test("googlesearch: options can disable goto resolution and enable AI Overview", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([
    {
      type: "organic",
      rank_absolute: 1,
      url: "https://example.com/",
      domain: "example.com",
      title: "Example",
    },
  ]);
  t.after(network.restore);

  const tool = await loadTool({ resolveGotoUrls: false, aiOverview: true });
  const result = await tool.execute({ queries: ["example"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.equal(network.calls[0].task.resolve_goto_urls, false);
  assert.equal(network.calls[0].task.load_async_ai_overview, true);
  assert.equal(output.searches[0].resolved.resolve_goto_urls, false);
  assert.equal(output.searches[0].resolved.load_async_ai_overview, true);
});

test("googlesearch: rejects more than five queries before calling the API", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([]);
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute(
    { queries: ["1", "2", "3", "4", "5", "6"] },
    toolContext(),
  );
  const output = JSON.parse(result.content);

  assert.match(output.error, /at most 5 queries/);
  assert.equal(network.calls.length, 0);
});

test("googlesearch: rejects queries longer than 700 characters", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([]);
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute(
    { queries: ["x".repeat(701)] },
    toolContext(),
  );
  const output = JSON.parse(result.content);

  assert.match(output.error, /at most 700 characters/);
  assert.equal(network.calls.length, 0);
});

test("googlesearch: serializes concurrent cost-log writes", async (t) => {
  const dir = await tempDir(t);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    GOOGLESEARCH_HISTORY_PATH: dir,
  });
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  const context = toolContext();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      tool.execute({ queries: [`query ${index}`] }, context),
    ),
  );

  const notes = results.flatMap(
    (result) => JSON.parse(result.content).notes ?? [],
  );
  assert.equal(
    notes.some((note: string) => /history could not be saved/.test(note)),
    false,
  );

  const log = JSON.parse(await readFile(join(dir, "cost-log.json"), "utf8"));
  assert.equal(log.total_searches, 8);
  assert.equal(log.entries.length, 8);
  assert.equal(log.total_cost_usd, 0.016);
});

test("googlesearch: writes private history without raw responses by default", async (t) => {
  const dir = await tempDir(t);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    GOOGLESEARCH_HISTORY_PATH: dir,
  });
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  await tool.execute({ queries: ["privacy"] }, toolContext());

  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const file = join(dir, files[0]);
  const record = JSON.parse((await readFile(file, "utf8")).trim());
  assert.equal(record.raw, null);
  assert.equal(record.request.query, "privacy");
  assert.equal(typeof record.duration_ms, "number");

  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
});

test("googlesearch: stores raw responses when historyRaw is enabled", async (t) => {
  const dir = await tempDir(t);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    GOOGLESEARCH_HISTORY_PATH: dir,
  });
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool({ historyRaw: true });
  await tool.execute({ queries: ["raw"] }, toolContext());

  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  const record = JSON.parse(
    (await readFile(join(dir, files[0]), "utf8")).trim(),
  );
  assert.equal(record.raw.status_code, 20000);
});

test("googlesearch: prunes history older than the retention window", async (t) => {
  const dir = await tempDir(t);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    GOOGLESEARCH_HISTORY_PATH: dir,
  });
  const stale = join(dir, "2000-01-01.jsonl");
  await writeFile(stale, "{}\n");
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  await tool.execute({ queries: ["retention"] }, toolContext());

  await assert.rejects(stat(stale), { code: "ENOENT" });
});

test("googlesearch: ignores a relative historyPath", async (t) => {
  const xdg = await tempDir(t);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    XDG_DATA_HOME: xdg,
  });
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool({ historyPath: "relative/history" });
  const result = await tool.execute({ queries: ["relative"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.match(output.notes.join("\n"), /only absolute paths are allowed/);
  const defaultDir = join(xdg, "opencode", "plugin-data", "googlesearch");
  const files = await readdir(defaultDir);
  assert.ok(files.some((name) => name.endsWith(".jsonl")));
});

test("googlesearch: environment variables override plugin options", async (t) => {
  const dir = await tempDir(t);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    GOOGLESEARCH_HISTORY_PATH: dir,
  });
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool({ history: false });
  await tool.execute({ queries: ["env wins"] }, toolContext());

  const files = await readdir(dir);
  assert.ok(files.some((name) => name.endsWith(".jsonl")));
});

test("googlesearch: retries transient failures once", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler((_url, _init, index) => {
    if (index === 0) {
      return jsonResponse(
        { status_code: 50000, status_message: "Internal SE Server Error." },
        500,
      );
    }
    return jsonResponse(
      okBody([
        { type: "organic", rank_absolute: 1, url: "https://example.com/" },
      ]),
    );
  });
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute({ queries: ["retry"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 2);
  assert.equal(output.searches[0].status, "ok");
  assert.match(output.notes.join("\n"), /Retried 1 .* 1 recovered/);
});

test("googlesearch: cancellation stops the retry wait", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(() =>
    jsonResponse(
      { status_code: 50000, status_message: "Internal SE Server Error." },
      500,
    ),
  );
  t.after(network.restore);

  const controller = new AbortController();
  const tool = await loadTool();
  const promise = tool.execute(
    { queries: ["cancel"] },
    toolContext(controller.signal),
  );
  await waitFor(() => network.calls.length >= 1);
  controller.abort();
  const result = await promise;
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.match(
    output.notes.join("\n"),
    /Retry skipped because the search was cancelled/,
  );
});

test("googlesearch: retries task status 40103", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(() =>
    jsonResponse({
      status_code: 20000,
      cost: 0,
      tasks: [
        {
          status_code: 40103,
          status_message: "Task execution failed.",
        },
      ],
    }),
  );
  t.after(network.restore);

  const controller = new AbortController();
  const tool = await loadTool();
  const promise = tool.execute(
    { queries: ["resubmit"] },
    toolContext(controller.signal),
  );
  await waitFor(() => network.calls.length >= 1);
  controller.abort();
  const result = await promise;
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.match(output.searches[0].error, /40103/);
  assert.match(
    output.notes.join("\n"),
    /Retry skipped because the search was cancelled/,
  );
});

test("googlesearch: maps a timeout without retrying", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(() => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  });
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute({ queries: ["timeout"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.match(output.searches[0].error, /timed out after 300s/);
});

test("googlesearch: does not retry HTTP 401", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(() =>
    jsonResponse({ status_code: 40100, status_message: "Unauthorized" }, 401),
  );
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute(
    { queries: ["unauthorized"] },
    toolContext(),
  );
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.match(output.searches[0].error, /rejected the credentials/);
});

test("googlesearch: does not retry a 402 out-of-credits response", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(() =>
    jsonResponse({ status_code: 40200, status_message: "Payment Required" }),
  );
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute({ queries: ["payment"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.match(output.searches[0].error, /out of credits/);
});

test("googlesearch: normalizes AI Overview text and references", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([
    {
      type: "ai_overview",
      items: [
        {
          type: "ai_overview_element",
          text: "First paragraph.",
          references: [
            {
              url: "https://reference.example/a",
              source: "Reference",
              domain: "reference.example",
              title: "A",
            },
          ],
        },
        { type: "ai_overview_element", text: "Second paragraph." },
      ],
    },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute({ queries: ["overview"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.equal(
    output.searches[0].ai_overview.text,
    "First paragraph.\n\nSecond paragraph.",
  );
  assert.deepEqual(output.searches[0].ai_overview.references, [
    {
      url: "https://reference.example/a",
      source: "Reference",
      domain: "reference.example",
      title: "A",
    },
  ]);
});

test("googlesearch: resolves location and language codes", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.de/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute(
    { queries: ["test"], location: "Germany", language: "de" },
    toolContext(),
  );
  const output = JSON.parse(result.content);

  assert.equal(network.calls[0].task.location_code, 2276);
  assert.equal(network.calls[0].task.language_code, "de");
  assert.equal(output.searches[0].resolved.location, "Germany");
});

test("googlesearch: honors the maxDepth setting", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool({ maxDepth: 20 });
  const rejected = await tool.execute(
    { queries: ["deep"], depth: 30 },
    toolContext(),
  );
  assert.match(JSON.parse(rejected.content).error, /configured maximum 20/);

  const accepted = await tool.execute(
    { queries: ["deep"], depth: 20 },
    toolContext(),
  );
  assert.equal(JSON.parse(accepted.content).searches[0].status, "ok");
  assert.equal(network.calls.length, 1);
  assert.equal(network.calls[0].task.depth, 20);
});

test("googlesearch: only warns about operators that are really operators", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  const operator = await tool.execute(
    { queries: ["site:example.com"] },
    toolContext(),
  );
  assert.match(
    JSON.parse(operator.content).notes.join("\n"),
    /multiplies the whole task price by 5/,
  );

  const ordinary = await tool.execute(
    { queries: ["contact info: 555-0100"] },
    toolContext(),
  );
  const ordinaryNotes = JSON.parse(ordinary.content).notes ?? [];
  assert.equal(
    ordinaryNotes.some((note: string) => /operator/i.test(note)),
    false,
  );
});

test("googlesearch: asserts the googlesearch permission before calling the API", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([]);
  t.after(network.restore);

  const asserted: any[] = [];
  const tool = await loadTool({}, async (input) => {
    asserted.push(input);
    throw new Error("denied by rule");
  });
  await assert.rejects(
    tool.execute({ queries: ["blocked", "Blocked"] }, toolContext()),
    /denied by rule/,
  );

  assert.equal(network.calls.length, 0);
  assert.equal(asserted.length, 1);
  assert.equal(asserted[0].action, "googlesearch");
  assert.deepEqual(asserted[0].resources, ["blocked"]);
  assert.deepEqual(asserted[0].source, {
    type: "tool",
    messageID: "msg_test",
    id: "call_test",
  });
});

test("googlesearch: reports duration per query, not per batch", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(async (_url, init) => {
    const task = JSON.parse(String(init?.body))[0];
    if (task.keyword === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return jsonResponse(
      okBody([
        { type: "organic", rank_absolute: 1, url: "https://example.com/" },
      ]),
    );
  });
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute(
    { queries: ["fast", "slow"] },
    toolContext(),
  );
  const output = JSON.parse(result.content);

  assert.ok(output.searches[0].duration_ms < 150);
  assert.ok(output.searches[1].duration_ms >= 150);
});

test("googlesearch: treats task status 40102 as no_results", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(() =>
    jsonResponse({
      status_code: 20000,
      status_message: "Ok.",
      cost: 0,
      tasks: [
        {
          status_code: 40102,
          status_message: "No Search Results.",
          cost: 0,
          result: null,
        },
      ],
    }),
  );
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute({ queries: ["nothing"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.equal(output.searches[0].status, "no_results");
});

test("googlesearch: maps insufficient funds (40210) to out of credits", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetchHandler(() =>
    jsonResponse({ status_code: 40210, status_message: "Insufficient funds." }),
  );
  t.after(network.restore);

  const tool = await loadTool();
  const result = await tool.execute({ queries: ["funds"] }, toolContext());
  const output = JSON.parse(result.content);

  assert.equal(network.calls.length, 1);
  assert.match(output.searches[0].error, /out of credits/);
});

test("googlesearch: clamps an out-of-range maxDepth instead of allowing 100", async (t) => {
  setEnv(t, baseEnv);
  const network = installFetch([]);
  t.after(network.restore);

  const tool = await loadTool({ maxDepth: 5 });
  const result = await tool.execute(
    { queries: ["deep"], depth: 20 },
    toolContext(),
  );

  assert.match(JSON.parse(result.content).error, /configured maximum 10/);
  assert.equal(network.calls.length, 0);
});

test("googlesearch: prunes cost-log entries outside the retention window", async (t) => {
  const dir = await tempDir(t);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    GOOGLESEARCH_HISTORY_PATH: dir,
  });
  await writeFile(
    join(dir, "cost-log.json"),
    JSON.stringify({
      total_cost_usd: 0.002,
      total_searches: 1,
      updated_at: "2000-01-01T00:00:00.000Z",
      entries: [
        {
          timestamp: "2000-01-01T00:00:00.000Z",
          query: "old private query",
          location: "United States",
          language: "English",
          depth: 10,
          results_count: 1,
          status: "ok",
          cost_usd: 0.002,
        },
      ],
    }),
  );
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  await tool.execute({ queries: ["new query"] }, toolContext());

  const log = JSON.parse(await readFile(join(dir, "cost-log.json"), "utf8"));
  assert.equal(log.total_searches, 2);
  assert.equal(log.total_cost_usd, 0.004);
  assert.deepEqual(
    log.entries.map((entry: { query: string }) => entry.query),
    ["new query"],
  );
});

test("googlesearch: does not chmod an existing configured history directory", async (t) => {
  if (process.platform === "win32") return;
  const dir = await tempDir(t);
  await chmod(dir, 0o755);
  setEnv(t, {
    ...baseEnv,
    GOOGLESEARCH_HISTORY: "1",
    GOOGLESEARCH_HISTORY_PATH: dir,
  });
  const network = installFetch([
    { type: "organic", rank_absolute: 1, url: "https://example.com/" },
  ]);
  t.after(network.restore);

  const tool = await loadTool();
  await tool.execute({ queries: ["shared dir"] }, toolContext());

  assert.equal((await stat(dir)).mode & 0o777, 0o755);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import { resolveDataForSeoCredentials } from "../src/credentials.ts";

function ctxWith(input: {
  connection?: unknown;
  credential?: unknown;
}): Plugin.Context {
  return {
    integration: {
      connection: {
        active: async () => input.connection,
        resolve: async () => input.credential,
      },
    },
  } as unknown as Plugin.Context;
}

test("DataForSEO: environment variables win", async (t) => {
  const previousLogin = process.env.DATAFORSEO_LOGIN;
  const previousPassword = process.env.DATAFORSEO_PASSWORD;
  t.after(() => {
    if (previousLogin === undefined) delete process.env.DATAFORSEO_LOGIN;
    else process.env.DATAFORSEO_LOGIN = previousLogin;
    if (previousPassword === undefined) delete process.env.DATAFORSEO_PASSWORD;
    else process.env.DATAFORSEO_PASSWORD = previousPassword;
  });

  process.env.DATAFORSEO_LOGIN = "env-login";
  process.env.DATAFORSEO_PASSWORD = "env-password";

  assert.deepEqual(await resolveDataForSeoCredentials(ctxWith({})), {
    login: "env-login",
    password: "env-password",
  });
});

test("DataForSEO: external credential metadata", async () => {
  const ctx = ctxWith({
    connection: { type: "credential", id: "cred_1", label: "DataForSEO" },
    credential: {
      type: "external",
      methodID: "login-password",
      metadata: { login: "form-login", password: "form-password" },
    },
  });

  assert.deepEqual(await resolveDataForSeoCredentials(ctx), {
    login: "form-login",
    password: "form-password",
  });
});

test("DataForSEO: login:password key", async () => {
  const ctx = ctxWith({
    connection: { type: "credential", id: "cred_1", label: "DataForSEO" },
    credential: { type: "key", key: "key-login:key-password" },
  });

  assert.deepEqual(await resolveDataForSeoCredentials(ctx), {
    login: "key-login",
    password: "key-password",
  });
});

test("DataForSEO: not connected", async () => {
  await assert.rejects(
    resolveDataForSeoCredentials(ctxWith({})),
    /Run \/connect, choose "DataForSEO"/,
  );
});

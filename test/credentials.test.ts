import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import {
  registerDataForSeoIntegration,
  resolveDataForSeoCredentials,
} from "../src/credentials.ts";

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

function clearCredentialEnv(t: { after: (fn: () => void) => void }): void {
  setEnv(t, {
    DATAFORSEO_LOGIN: undefined,
    DATAFORSEO_PASSWORD: undefined,
  });
}

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
  clearCredentialEnv(t);
  process.env.DATAFORSEO_LOGIN = "env-login";
  process.env.DATAFORSEO_PASSWORD = "env-password";

  assert.deepEqual(await resolveDataForSeoCredentials(ctxWith({})), {
    login: "env-login",
    password: "env-password",
  });
});

test("DataForSEO: key credential with login metadata", async (t) => {
  clearCredentialEnv(t);

  const ctx = ctxWith({
    connection: { type: "credential", id: "cred_1", label: "DataForSEO" },
    credential: {
      type: "key",
      key: "key-password",
      metadata: { login: "form-login" },
    },
  });

  assert.deepEqual(await resolveDataForSeoCredentials(ctx), {
    login: "form-login",
    password: "key-password",
  });
});

test("DataForSEO: legacy external credential metadata", async (t) => {
  clearCredentialEnv(t);

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

test("DataForSEO: login:password key", async (t) => {
  clearCredentialEnv(t);

  const ctx = ctxWith({
    connection: { type: "credential", id: "cred_1", label: "DataForSEO" },
    credential: { type: "key", key: "key-login:key-password" },
  });

  assert.deepEqual(await resolveDataForSeoCredentials(ctx), {
    login: "key-login",
    password: "key-password",
  });
});

test("DataForSEO: registers a key method with a login field", async () => {
  let method: any;
  const ctx = {
    integration: {
      transform: async (fn: any) =>
        fn({
          update: () => {},
          method: {
            update: (input: any) => {
              method = input.method;
            },
          },
        }),
    },
  } as unknown as Plugin.Context;

  await registerDataForSeoIntegration(ctx);

  assert.equal(method.type, "key");
  assert.equal(method.label, "DataForSEO login & API password");
  assert.equal(method.form[0].key, "login");
  assert.equal(method.form[0].required, true);
});

test("DataForSEO: not connected", async (t) => {
  clearCredentialEnv(t);

  await assert.rejects(
    resolveDataForSeoCredentials(ctxWith({})),
    /Run \/connect, choose "DataForSEO"/,
  );
});

import type { Plugin } from "@opencode/plugin";

/**
 * Use the canonical integration ID so users see a single clear DataForSEO
 * entry in /connect. Keeping it stable preserves existing connections; a
 * future built-in integration with the same ID would take precedence.
 */
export const DATAFORSEO_INTEGRATION_ID = "dataforseo";

export type DataForSeoCredentials = {
  login: string;
  password: string;
};

/**
 * Registers the DataForSEO integration and its credential form.
 *
 * The login is collected by the form and the API password is the connection
 * key. OpenCode stores the key as the credential secret, so the password is
 * not kept in form metadata.
 */
export async function registerDataForSeoIntegration(
  ctx: Plugin.Context,
): Promise<void> {
  await ctx.integration.transform((editor) => {
    editor.update(DATAFORSEO_INTEGRATION_ID, (integration) => {
      integration.name = "DataForSEO";
    });

    editor.method.update({
      integrationID: DATAFORSEO_INTEGRATION_ID,
      method: {
        type: "key",
        label: "DataForSEO login & API password",
        form: [
          {
            type: "string",
            key: "login",
            title: "DataForSEO login",
            description:
              "Your DataForSEO account login, usually the account email.",
            required: true,
          },
        ],
      },
    });
  });
}

/**
 * Resolves credentials in this order:
 *
 * 1. `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` environment variables (CI).
 * 2. The active `dataforseo` connection created through `/connect`:
 *    - `key`: login from the form metadata, password from the key.
 *    - `external`: legacy connections created before the key method.
 *    - A key in the form `login:password` (advanced users).
 *
 * If none is available, the tool returns a clear error instead of making a
 * request.
 */
export async function resolveDataForSeoCredentials(
  ctx: Plugin.Context,
): Promise<DataForSeoCredentials> {
  const envLogin = process.env.DATAFORSEO_LOGIN?.trim();
  const envPassword = process.env.DATAFORSEO_PASSWORD?.trim();
  if (envLogin && envPassword) {
    return { login: envLogin, password: envPassword };
  }

  const connection = await ctx.integration.connection.active(
    DATAFORSEO_INTEGRATION_ID,
  );
  if (connection) {
    const credential = await ctx.integration.connection.resolve(connection);

    if (credential?.type === "key") {
      const login = stringValue(credential.metadata?.login);
      const password = stringValue(credential.key);
      if (login && password) return { login, password };
      const parsed = parseLoginPassword(credential.key);
      if (parsed) return parsed;
    }

    if (credential?.type === "external") {
      const login = stringValue(credential.metadata?.login);
      const password = stringValue(credential.metadata?.password);
      if (login && password) return { login, password };
    }
  }

  throw new Error(
    `googlesearch is not connected. Run /connect, choose "DataForSEO", enter your API login, and provide your API password. ` +
      `Alternatively set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD. Do not retry until configured.`,
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseLoginPassword(raw: string): DataForSeoCredentials | undefined {
  const value = raw.trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;

  const login = value.slice(0, separator).trim();
  const password = value.slice(separator + 1).trim();
  return login && password ? { login, password } : undefined;
}

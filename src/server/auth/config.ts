export const providers = ["google", "telegram"] as const;
export type Provider = (typeof providers)[number];
export const approvedTunnelOrigin = "https://liable-pleat-maritime.ngrok-free.dev";
export const issuers: Record<Provider, string> = {
  google: "https://accounts.google.com",
  telegram: "https://oauth.telegram.org",
};

export function isProvider(value: string): value is Provider {
  return providers.some((provider) => provider === value);
}

export function authConfig(env: Record<string, string | undefined> = process.env) {
  if (env.SHOWUP_AUTH !== "1") return null;
  let origin: URL;
  try {
    origin = new URL(env.SHOWUP_AUTH_ORIGIN ?? "");
  } catch {
    throw new Error("SHOWUP_AUTH_ORIGIN is required");
  }
  if (
    origin.protocol !== "https:" ||
    (!["localhost", "127.0.0.1"].includes(origin.hostname) &&
      !(origin.origin === approvedTunnelOrigin && env.NODE_ENV === "production")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "Authentication requires HTTPS loopback or the approved production-mode tunnel",
    );
  const encryptionKey = env.SHOWUP_IDENTITY_KEY ?? "";
  const indexKey = env.SHOWUP_IDENTITY_INDEX_KEY ?? "";
  if (
    !/^[0-9a-f]{64}$/.test(encryptionKey) ||
    !/^[0-9a-f]{64}$/.test(indexKey) ||
    indexKey === encryptionKey
  )
    throw new Error("Separate 32-byte identity encryption and index keys are required");
  const clients = Object.fromEntries(
    providers.map((provider) => {
      const prefix = `SHOWUP_${provider.toUpperCase()}`;
      const id = env[`${prefix}_CLIENT_ID`];
      const secret = env[`${prefix}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret))
        throw new Error(`${prefix} client configuration is incomplete`);
      return [provider, id && secret ? { id, secret } : null];
    }),
  ) as Record<Provider, { id: string; secret: string } | null>;
  return { origin: origin.origin, encryptionKey, indexKey, clients };
}
export type AuthConfig = NonNullable<ReturnType<typeof authConfig>>;

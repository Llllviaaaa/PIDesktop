import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    credentials: Credentials;
  }
}

/**
 * Where a secret comes from (ADR 0007). Configuration files hold one of these,
 * never a key written out unless the user chose `value`:
 * - `env`: an environment variable of the host process;
 * - `secret`: an id a registered store resolves (the desktop app's
 *   DPAPI-protected store, once it is bridged in P5);
 * - `value`: the key itself.
 */
export type SecretRef = { env: string } | { secret: string } | { value: string };

export type SecretResolver = (id: string) => Promise<string | undefined>;

export function isSecretRef(value: unknown): value is SecretRef {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const [key] = keys;
  return (key === "env" || key === "secret" || key === "value") && typeof (value as Record<string, unknown>)[key] === "string";
}

/** Resolves SecretRefs for adapters; stores register themselves for `secret` refs. */
export class Credentials extends Service {
  private store: SecretResolver | undefined;

  constructor(ctx: Context) {
    super(ctx, "credentials");
  }

  /** Install the resolver for `{ secret }` refs. Returns its disposer. */
  registerStore(resolver: SecretResolver): () => void {
    if (this.store !== undefined) throw new Error("A secret store is already registered");
    this.store = resolver;
    return () => {
      if (this.store === resolver) this.store = undefined;
    };
  }

  async resolve(ref: SecretRef | undefined): Promise<string | undefined> {
    if (ref === undefined) return undefined;
    if ("value" in ref) return ref.value;
    if ("env" in ref) {
      const value = process.env[ref.env];
      return value === undefined || value === "" ? undefined : value;
    }
    if (this.store === undefined) throw new Error(`No secret store is available for "${ref.secret}"`);
    return this.store(ref.secret);
  }

  /** How a ref is described to the UI, without the secret. */
  describe(ref: SecretRef | undefined): string {
    if (ref === undefined) return "none";
    if ("value" in ref) return "stored in config";
    if ("env" in ref) return `environment variable ${ref.env}`;
    return "secret store";
  }
}

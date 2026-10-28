import { Context, Service } from "@deepseek-ai/cordis";
import { PROTOCOL_VERSION } from "@pid/protocol";

declare module "@deepseek-ai/cordis" {
  interface Context {
    hostInfo: HostInfo;
  }
}

export interface HostInfoConfig {
  /** The Pi Desktop build this host ships with. */
  version: string;
  dataDir: string;
}

/** What every plugin may ask about the host it runs in. */
export class HostInfo extends Service {
  readonly version: string;
  readonly protocolVersion = PROTOCOL_VERSION;
  readonly dataDir: string;
  readonly startedAt = new Date();

  constructor(ctx: Context, config: HostInfoConfig) {
    super(ctx, "hostInfo");
    this.version = config.version;
    this.dataDir = config.dataDir;
  }
}

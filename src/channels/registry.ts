import type { Config } from "../config.js";
import type { Channel } from "../db/schema.js";
import type { ChannelAdapter } from "./adapter.js";
import { MockAdapter } from "./mock/index.js";

// One adapter instance per channel per process. A channel whose credentials
// are absent gets the mock, clearly flagged, so the whole loop runs offline.
// Meta (Phase 4) and Google (Phase 5) register here when they exist.
export class AdapterRegistry {
  private readonly mock = new MockAdapter();
  private readonly real = new Map<Channel, ChannelAdapter>();

  constructor(private readonly config: Config) {}

  register(adapter: ChannelAdapter): void {
    this.real.set(adapter.channel, adapter);
  }

  /** The adapter to use for a channel, or null when the channel is not supported at all. */
  get(channel: Channel): ChannelAdapter | null {
    if (channel === "mock") return this.mock;
    const real = this.real.get(channel);
    if (real && !this.isMocked(channel)) return real;
    if (channel === "meta" || channel === "google") return this.mock; // mocked until credentials and the adapter exist
    return null; // reddit, chatgpt: no adapter yet, mocked or otherwise
  }

  isMocked(channel: Channel): boolean {
    if (channel === "mock") return true;
    if (channel === "meta") return this.config.mock.meta;
    if (channel === "google") return this.config.mock.googleAds;
    return true;
  }

  /** The mock itself, for tests and the dev seed. */
  get mockAdapter(): MockAdapter {
    return this.mock;
  }
}

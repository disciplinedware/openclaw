import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

/** Opens a store once per runtime object: a plugin reload hands the plugin a fresh runtime. */
export function createPerRuntimeStoreOpener<TStore>(
  open: (runtime: PluginRuntime) => TStore,
): (runtime: PluginRuntime) => TStore {
  const stores = new WeakMap<PluginRuntime, TStore>();
  return (runtime) => {
    let store = stores.get(runtime);
    if (!store) {
      store = open(runtime);
      stores.set(runtime, store);
    }
    return store;
  };
}

/**
 * Runs writes of one key one after another. The channel runtime writes from inbound and send paths
 * that run concurrently; the chains are process-global, under `symbolName`, because the plugin loads
 * in several module instances.
 */
export function createKeyedWriteQueue(
  symbolName: string,
): (key: string, write: () => Promise<void>) => Promise<void> {
  const chains = resolveGlobalMap<string, Promise<void>>(Symbol.for(symbolName));
  return async (key, write) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(write);
    const settled = next.catch(() => {});
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) {
        chains.delete(key);
      }
    });
    await next;
  };
}

import type { PluginRuntime } from "openclaw/plugin-sdk/core";

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

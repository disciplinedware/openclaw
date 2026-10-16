// In-memory stand-in for `runtime.state.openKeyedStore`, with the host's key, TTL and
// evict-oldest rules. The published host ships no test runtime for plugin state.
type Entry = { value: unknown; createdAt: number; expiresAt?: number };

export function createMemoryPluginStateRuntime(now: () => number = Date.now) {
  const namespaces = new Map<string, Map<string, Entry>>();

  const openKeyedStore = <T>(options: {
    namespace: string;
    maxEntries: number;
    defaultTtlMs?: number;
  }) => {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("plugin state maxEntries must be an integer >= 1");
    }
    const entries = namespaces.get(options.namespace) ?? new Map<string, Entry>();
    namespaces.set(options.namespace, entries);
    const validKey = (key: string) => {
      const trimmed = key.trim();
      if (!trimmed) {
        throw new Error("plugin state entry key must not be empty");
      }
      return trimmed;
    };
    const live = (key: string): Entry | undefined => {
      const entry = entries.get(key);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    };
    return {
      async register(key: string, value: T, opts?: { ttlMs?: number }) {
        const ttlMs = opts?.ttlMs ?? options.defaultTtlMs;
        const validated = validKey(key);
        entries.delete(validated);
        entries.set(validated, {
          value: structuredClone(value),
          createdAt: now(),
          ...(ttlMs !== undefined ? { expiresAt: now() + ttlMs } : {}),
        });
        while (entries.size > options.maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          entries.delete(oldest);
        }
      },
      async lookup(key: string): Promise<T | undefined> {
        // SAFETY: a namespace's values are written only by register(), which takes T.
        return structuredClone(live(validKey(key))?.value) as T | undefined;
      },
      async delete(key: string) {
        return entries.delete(validKey(key));
      },
      async entries() {
        return [...entries.keys()].flatMap((key) => {
          const entry = live(key);
          if (!entry) {
            return [];
          }
          // SAFETY: a namespace's values are written only by register(), which takes T.
          const value = structuredClone(entry.value) as T;
          return [{ key, value, createdAt: entry.createdAt }];
        });
      },
    };
  };

  return {
    runtime: {
      state: { openKeyedStore },
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
      },
    },
    namespaces,
  };
}

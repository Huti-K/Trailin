export interface ProviderRegistry<T> {
  register: (app: string, provider: T) => void;
  /** null when `app` has no driver of this kind; callers handle that. */
  get: (app: string) => T | null;
}

export function createProviderRegistry<T>(): ProviderRegistry<T> {
  const registry = new Map<string, T>();
  return {
    register(app, provider) {
      registry.set(app, provider);
    },
    get(app) {
      return registry.get(app) ?? null;
    },
  };
}

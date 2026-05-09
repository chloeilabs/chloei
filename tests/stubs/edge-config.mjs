const edgeConfigStoreKey = Symbol.for("chloei.tests.edge-config-store")

export async function get(key) {
  const store = globalThis[edgeConfigStoreKey]
  if (!store || typeof store !== "object") {
    return undefined
  }

  return store[key]
}

import { getTestMocks } from "./mock-state.mjs"

export function getDatabase() {
  return getTestMocks().postgres?.getDatabase?.() ?? { kind: "mock-db" }
}

export function isPrimaryDatabaseConfigured() {
  return getTestMocks().postgres?.isPrimaryDatabaseConfigured?.() ?? true
}

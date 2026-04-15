import { Kysely, PostgresDialect } from "kysely"
import { Pool } from "pg"

import { normalizePostgresConnectionString } from "./postgres-url.mjs"

declare global {
  var chloeiPgPool: Pool | undefined
  var chloeiDatabase: Kysely<Record<string, never>> | undefined
  var chloeiAuthPgPool: Pool | undefined
  var chloeiAuthDatabase: Kysely<Record<string, never>> | undefined
}

export const DATABASE_URL_ENV_NAME = "DATABASE_URL" as const
export const AUTH_DATABASE_URL_ENV_NAME = "AUTH_DATABASE_URL" as const

type DatabaseUrlEnvName =
  | typeof DATABASE_URL_ENV_NAME
  | typeof AUTH_DATABASE_URL_ENV_NAME

function getConfiguredDatabaseUrl(name: DatabaseUrlEnvName): string | null {
  const databaseUrl = process.env[name]?.trim()
  if (!databaseUrl) {
    if (name === AUTH_DATABASE_URL_ENV_NAME) {
      return getConfiguredDatabaseUrl(DATABASE_URL_ENV_NAME)
    }

    return null
  }

  return normalizePostgresConnectionString(databaseUrl)
}

function getRequiredDatabaseUrl(name: DatabaseUrlEnvName): string {
  const databaseUrl = getConfiguredDatabaseUrl(name)

  if (!databaseUrl) {
    throw new Error(`Missing ${name}.`)
  }

  return databaseUrl
}

function createPool(connectionString: string) {
  return new Pool({
    connectionString,
  })
}

function createDatabase(pool: Pool) {
  return new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
  })
}

function isDatabaseConfigured(name: DatabaseUrlEnvName): boolean {
  return getConfiguredDatabaseUrl(name) !== null
}

function getPrimaryDatabaseOrNull(): Kysely<Record<string, never>> | null {
  if (!isDatabaseConfigured(DATABASE_URL_ENV_NAME)) {
    return null
  }

  const existingDatabase = globalThis.chloeiDatabase
  if (existingDatabase) {
    return existingDatabase
  }

  const pgPool =
    globalThis.chloeiPgPool ??
    createPool(getRequiredDatabaseUrl(DATABASE_URL_ENV_NAME))
  const database = createDatabase(pgPool)

  globalThis.chloeiPgPool ??= pgPool
  globalThis.chloeiDatabase ??= database

  return globalThis.chloeiDatabase
}

export function getDatabase(): Kysely<Record<string, never>> {
  const database = getPrimaryDatabaseOrNull()

  if (!database) {
    throw new Error("Missing DATABASE_URL.")
  }

  return database
}

function getAuthDatabaseOrNull(): Kysely<Record<string, never>> | null {
  if (!isDatabaseConfigured(AUTH_DATABASE_URL_ENV_NAME)) {
    return null
  }

  const authDatabaseUrl = getRequiredDatabaseUrl(AUTH_DATABASE_URL_ENV_NAME)
  const primaryDatabaseUrl = getConfiguredDatabaseUrl(DATABASE_URL_ENV_NAME)

  if (authDatabaseUrl === primaryDatabaseUrl) {
    return getPrimaryDatabaseOrNull()
  }

  const existingDatabase = globalThis.chloeiAuthDatabase
  if (existingDatabase) {
    return existingDatabase
  }

  const pgPool = globalThis.chloeiAuthPgPool ?? createPool(authDatabaseUrl)
  const database = createDatabase(pgPool)

  globalThis.chloeiAuthPgPool ??= pgPool
  globalThis.chloeiAuthDatabase ??= database

  return globalThis.chloeiAuthDatabase
}

export function getAuthDatabase(): Kysely<Record<string, never>> {
  const database = getAuthDatabaseOrNull()

  if (!database) {
    throw new Error(
      `Missing ${AUTH_DATABASE_URL_ENV_NAME} or ${DATABASE_URL_ENV_NAME}.`
    )
  }

  return database
}

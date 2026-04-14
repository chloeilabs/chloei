import assert from "node:assert/strict"
import test from "node:test"

import { normalizePostgresConnectionString } from "../src/lib/server/postgres-url.mjs"

test("postgres connection normalization upgrades require-like sslmode to verify-full", () => {
  const result = normalizePostgresConnectionString(
    "postgres://user:pass@db.example.com/chloei?sslmode=require"
  )

  assert.equal(
    result,
    "postgres://user:pass@db.example.com/chloei?sslmode=verify-full"
  )
})

test("postgres connection normalization preserves explicit libpq compatibility", () => {
  const result = normalizePostgresConnectionString(
    "postgres://user:pass@db.example.com/chloei?sslmode=require&uselibpqcompat=true"
  )

  assert.equal(
    result,
    "postgres://user:pass@db.example.com/chloei?sslmode=require&uselibpqcompat=true"
  )
})

test("postgres connection normalization leaves unsupported sslmodes alone", () => {
  const result = normalizePostgresConnectionString(
    "postgres://user:pass@db.example.com/chloei?sslmode=no-verify"
  )

  assert.equal(
    result,
    "postgres://user:pass@db.example.com/chloei?sslmode=no-verify"
  )
})

test("postgres connection normalization ignores invalid urls", () => {
  const result = normalizePostgresConnectionString("not a connection string")

  assert.equal(result, "not a connection string")
})

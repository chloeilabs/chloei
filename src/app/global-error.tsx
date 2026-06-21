"use client"

import { useEffect } from "react"

// global-error replaces the root layout when the root layout/template itself
// throws, so it must render its own <html>/<body> and cannot rely on the app's
// theme/CSS. Keep it fully self-contained (Client Component, inline styles).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          backgroundColor: "#000",
          color: "#fff",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <title>Something went wrong — Chloei</title>
        <main style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1
            style={{
              margin: "0 0 0.5rem",
              fontSize: "1.125rem",
              fontWeight: 600,
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              margin: "0 0 1.5rem",
              fontSize: "0.875rem",
              color: "rgba(255, 255, 255, 0.6)",
            }}
          >
            An unexpected error occurred. Try reloading the page.
          </p>
          <button
            type="button"
            onClick={() => {
              reset()
            }}
            style={{
              cursor: "pointer",
              borderRadius: "9999px",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              backgroundColor: "rgba(255, 255, 255, 0.1)",
              color: "#fff",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p
              style={{
                marginTop: "1rem",
                fontSize: "0.75rem",
                color: "rgba(255, 255, 255, 0.4)",
              }}
            >
              Error reference: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  )
}

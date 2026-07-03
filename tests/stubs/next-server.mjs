function normalizeInit(init) {
  const nextInit = init ?? {}
  return {
    ...nextInit,
    headers: new Headers(nextInit.headers),
  }
}

export class NextResponse extends Response {
  static json(body, init) {
    const normalizedInit = normalizeInit(init)

    if (!normalizedInit.headers.has("Content-Type")) {
      normalizedInit.headers.set("Content-Type", "application/json")
    }

    return new NextResponse(JSON.stringify(body), normalizedInit)
  }
}

// Next 16 after(): run the task immediately so tests observe its effects
// synchronously (the real one defers until the response is sent).
export function after(task) {
  if (typeof task === "function") {
    void task()
  }
}

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

const capturesKey = Symbol.for("chloei.tests.posthog-captures")

export class PostHog {
  constructor(token, options) {
    this.token = token
    this.options = options
  }

  capture(event) {
    const captures = Array.isArray(globalThis[capturesKey])
      ? globalThis[capturesKey]
      : []
    captures.push({
      event,
      options: this.options,
      token: this.token,
    })
    globalThis[capturesKey] = captures
  }

  async shutdown() {
    return undefined
  }
}

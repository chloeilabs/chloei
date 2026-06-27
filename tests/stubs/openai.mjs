import { getTestMocks } from "./mock-state.mjs"

export default class OpenAI {
  constructor(options) {
    this.options = options
    this.responses = {
      create: async (params, requestOptions) => {
        const impl = getTestMocks().openai?.responsesCreate
        if (typeof impl === "function") {
          return impl(params, requestOptions)
        }
        return { output_text: "{}" }
      },
    }
  }
}

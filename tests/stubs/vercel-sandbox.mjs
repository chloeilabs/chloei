export const createdSandboxes = []

export class Sandbox {
  static async create(options) {
    const sandbox = new Sandbox(options)
    createdSandboxes.push(sandbox)
    return sandbox
  }

  constructor(options) {
    this.options = options
    this.sandboxId = "stub-sandbox"
    this.files = new Map()
    this.fs = {
      mkdir: async () => undefined,
      writeFile: async (filePath, contents) => {
        this.files.set(filePath, String(contents))
      },
      readdir: async () => [],
      stat: async () => null,
    }
  }

  async runCommand(command) {
    this.lastCommand = command
    return {
      exitCode: 0,
      logs: () => ({
        async *[Symbol.asyncIterator]() {
          yield { stream: "stdout", data: "sandbox ok\n" }
        },
        close() {},
      }),
    }
  }

  async stop(options) {
    this.stopOptions = options
  }
}

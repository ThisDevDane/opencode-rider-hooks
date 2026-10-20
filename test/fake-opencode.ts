import type { Mcp, Plugin } from "@opencode/plugin"
import type { Result } from "@opencode/plugin/promise/tool"
import { register } from "../index.ts"
import type { StepName } from "../rider.ts"

export type ToolState = "available" | "unavailable" | "denied" | "failed"

interface FixtureOptions {
  workingDirectory?: string
  mcpServer?: Mcp.ServerConfig
  projectErrors?: Record<string, string>
  formatter?: ToolState
  diagnostics?: ToolState
  formatterOutput?: string
  diagnosticOutput?: string
}

interface FormatRequest {
  files: string[]
  projectPath?: string
}

interface DiagnosticRequest extends FormatRequest {
  min_severity: string
  timeout: number
}

interface TestEvent {
  tool: string
  status: "completed" | "error"
  input: unknown
  sessionID: string
  agent: string
  messageID: string
  id: string
  result: Result
}

type AfterEditHook = (event: TestEvent) => Promise<void>

export function createFixture(repositoryRoot: string, options: FixtureOptions = {}) {
  let afterEdit: AfterEditHook | undefined
  let formatterState = options.formatter
  let diagnosticsState = options.diagnostics
  const formatRequests: FormatRequest[] = []
  const diagnosticRequests: DiagnosticRequest[] = []
  const permissionActions: string[] = []
  const executionOrder: string[] = []
  const lookupCounts = { tools: 0, sessions: 0 }

  function checkProject(input: FormatRequest) {
    const error = input.projectPath && options.projectErrors?.[input.projectPath]
    if (error) {
      throw new Error(error)
    }
  }

  const formatter = {
    id: "rider_reformat_file",
    async execute(input: FormatRequest) {
      formatRequests.push(input)
      executionOrder.push("formatting started")
      await Promise.resolve()
      checkProject(input)
      if (formatterState === "failed") {
        throw new Error("Rider formatter failed")
      }
      executionOrder.push("formatting completed")
      return { content: options.formatterOutput ?? "ok" }
    },
  }

  const diagnostics = {
    id: "rider_lint_files",
    async execute(input: DiagnosticRequest) {
      diagnosticRequests.push(input)
      executionOrder.push("diagnostics")
      checkProject(input)
      if (diagnosticsState === "failed") {
        throw new Error("Rider disconnected")
      }
      const text = options.diagnosticOutput ?? '{"items":[],"more":true}'
      return { content: [{ type: "text", text }] }
    },
  }

  // Only implement the OpenCode methods this plugin uses. Keep the cast here,
  // rather than weakening the event and request types throughout the tests.
  const plugin = {
    mcp: {
      async transform(callback: (editor: { get(name: string): Mcp.ServerConfig | undefined }) => void) {
        callback({
          get(name) {
            if (name !== "rider") {
              throw new Error(`Unexpected MCP server: ${name}`)
            }
            return options.mcpServer
          },
        })
      },
    },
    session: {
      async get() {
        lookupCounts.sessions++
        return { location: { directory: options.workingDirectory ?? repositoryRoot } }
      },
    },
    tool: {
      async hook(name: string, callback: AfterEditHook) {
        if (name !== "execute.after") {
          throw new Error(`Unexpected hook: ${name}`)
        }
        afterEdit = callback
      },
      async list() {
        lookupCounts.tools++
        const tools = []
        if (formatterState !== "unavailable") {
          tools.push(formatter)
        }
        if (diagnosticsState !== "unavailable") {
          tools.push(diagnostics)
        }
        return tools
      },
    },
    permission: {
      async assert(request: { action: string }) {
        permissionActions.push(request.action)
        const formattingDenied = request.action === formatter.id && formatterState === "denied"
        const diagnosticsDenied = request.action === diagnostics.id && diagnosticsState === "denied"
        if (formattingDenied || diagnosticsDenied) {
          throw new Error("Permission denied")
        }
      },
    },
  } as unknown as Plugin.Context

  const event: TestEvent = {
    tool: "patch",
    status: "completed",
    input: {},
    sessionID: "session",
    agent: "build",
    messageID: "message",
    id: "call",
    result: {
      content: "Edit succeeded",
      metadata: { files: [{ file: "src/App/Example.cs", status: "modified" }] },
    },
  }

  async function start() {
    const cleanup = await register(plugin, repositoryRoot)
    return {
      async run() {
        if (!afterEdit) {
          throw new Error("Post-edit hook was not registered")
        }
        await afterEdit(event)
      },
      cleanup,
    }
  }

  return {
    event,
    formatRequests,
    diagnosticRequests,
    permissionActions,
    executionOrder,
    lookupCounts,
    start,
    setToolStates(formatter: ToolState, diagnostics: ToolState) {
      formatterState = formatter
      diagnosticsState = diagnostics
    },
    setEditedFiles(paths: string[]) {
      event.result = {
        ...event.result,
        metadata: { files: paths.map(file => ({ file, status: "modified" })) },
      }
    },
    async run() {
      const hook = await start()
      try {
        await hook.run()
      } finally {
        hook.cleanup()
      }
    },
  }
}

export function getReportText(result: Result, step: StepName): string {
  if (!Array.isArray(result.content)) {
    throw new Error(`Missing ${step} report`)
  }

  const heading = `Rider post-edit ${step}\n`
  for (const part of result.content) {
    if (part.type === "text" && part.text.startsWith(heading)) {
      return part.text
    }
  }
  throw new Error(`Missing ${step} report`)
}

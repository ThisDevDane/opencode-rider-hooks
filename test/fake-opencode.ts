import type { Mcp, Plugin } from "@opencode/plugin"
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { Result } from "@opencode/plugin/promise/tool"
import riderHooks, { register } from "../index.ts"
import type { StepName } from "../rider.ts"
import type { launchRider } from "../worktrees.ts"

export type ToolState = "available" | "unavailable" | "denied" | "failed"

interface FixtureOptions {
  pluginOptions?: Record<string, unknown>
  launch?: typeof launchRider
  existingSession?: boolean
  onSessionGet?: (count: number) => Promise<void>
  workingDirectory?: string
  canonicalRoot?: string
  mcpServer?: Mcp.ServerConfig
  mcpStatus?: Mcp.Status
  omitMcpStatus?: boolean
  lookupErrors?: { session?: string; mcp?: string; tools?: string }
  projectErrors?: Record<string, string>
  formatter?: ToolState
  diagnostics?: ToolState
  formatterOutput?: string
  formatterErrors?: string[]
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
type PromptRequest = Parameters<Plugin.Context["session"]["prompt"]>[0]
type SyntheticRequest = Parameters<Plugin.Context["session"]["synthetic"]>[0]
type PublicEvent = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event> ? Event : never

export function createFixture(repositoryRoot: string, options: FixtureOptions = {}) {
  let afterEdit: AfterEditHook | undefined
  let mcpTransform: (() => void) | undefined
  let mcpServer = options.mcpServer
  let mcpStatus: Mcp.Status = options.mcpStatus ?? { status: mcpServer?.disabled ? "disabled" : "connected" }
  let formatterState = options.formatter
  let diagnosticsState = options.diagnostics
  let sessionDirectory = options.workingDirectory ?? repositoryRoot
  let sessionProject = "project"
  let parentID: string | undefined
  let onPrompt: ((event: SessionPrompt) => Promise<void>) | undefined
  const events: PublicEvent[] = []
  let wake: (() => void) | undefined
  let subscriptionSignal: AbortSignal | undefined
  const formatRequests: FormatRequest[] = []
  const diagnosticRequests: DiagnosticRequest[] = []
  const permissionActions: string[] = []
  const executionOrder: string[] = []
  const lookupCounts = { tools: 0, sessions: 0 }
  const commands = new Map<string, CommandDefinition>()
  const prompts: PromptRequest[] = []
  const syntheticMessages: SyntheticRequest[] = []

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
      const error = options.formatterErrors?.[formatRequests.length - 1]
      if (error) {
        throw new Error(error)
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
    options: options.pluginOptions ?? {},
    location: {
      directory: options.workingDirectory ?? repositoryRoot,
      project: {
        id: "project",
        directory: repositoryRoot,
        canonical: options.canonicalRoot ?? repositoryRoot,
      },
    },
    mcp: {
      async transform(callback: (editor: { get(name: string): Mcp.ServerConfig | undefined }) => void) {
        mcpTransform = () => callback({
          get(name) {
            if (name !== "rider") {
              throw new Error(`Unexpected MCP server: ${name}`)
            }
            return mcpServer
          },
        })
        mcpTransform()
      },
      async list() {
        if (options.lookupErrors?.mcp) {
          throw new Error(options.lookupErrors.mcp)
        }
        return {
          data: mcpServer && !options.omitMcpStatus ? [{ name: "rider", status: mcpStatus }] : [],
        }
      },
    },
    command: {
      async transform(callback: (editor: { add(command: CommandDefinition): void }) => void) {
        callback({ add: command => { commands.set(command.name, command) } })
      },
    },
    session: {
      async list() {
        return {
          data: options.existingSession ? [{
            id: "session", projectID: sessionProject, parentID,
            location: { directory: sessionDirectory },
          }] : [],
          cursor: {},
        }
      },
      async hook(name: string, callback: typeof onPrompt) {
        if (name !== "prompt") throw new Error(`Unexpected session hook: ${name}`)
        onPrompt = callback
      },
      async get() {
        lookupCounts.sessions++
        if (options.lookupErrors?.session) {
          throw new Error(options.lookupErrors.session)
        }
        await options.onSessionGet?.(lookupCounts.sessions)
        return { projectID: sessionProject, parentID, location: { directory: sessionDirectory } }
      },
      async synthetic(request: SyntheticRequest) {
        syntheticMessages.push(request)
      },
      async prompt(request: PromptRequest) {
        prompts.push(request)
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        subscriptionSignal = signal
        const onAbort = () => wake?.()
        signal.addEventListener("abort", onAbort)
        try {
          while (!signal.aborted) {
            const event = events.shift()
            if (event) yield event
            else await new Promise<void>(resolve => { wake = resolve })
          }
        } finally {
          signal.removeEventListener("abort", onAbort)
        }
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
        if (options.lookupErrors?.tools) {
          throw new Error(options.lookupErrors.tools)
        }
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
    const cleanup = options.launch
      ? await register(plugin, plugin.location.project.directory, options.launch)
      : await riderHooks.setup(plugin)
    return {
      async run() {
        if (!afterEdit) {
          throw new Error("Post-edit hook was not registered")
        }
        await afterEdit(event)
      },
      async runCommand(
        delivery: CommandInvocation["delivery"] = "steer",
        prompt: CommandInvocation["prompt"] = { text: "" },
      ) {
        const command = commands.get("rider-status")
        if (!command) {
          throw new Error("Rider status command was not registered")
        }
        await command.execute({
          sessionID: event.sessionID as CommandInvocation["sessionID"],
          prompt,
          delivery,
        })
      },
      async runPrompt(metadata?: Record<string, unknown>) {
        await onPrompt?.({
          sessionID: event.sessionID as SessionPrompt["sessionID"],
          messageID: event.messageID as SessionPrompt["messageID"],
          prompt: { text: "Work on this project" },
          delivery: "steer",
          metadata,
        })
      },
      cleanup: () => cleanup?.(),
    }
  }

  return {
    event,
    formatRequests,
    diagnosticRequests,
    permissionActions,
    executionOrder,
    lookupCounts,
    commands,
    prompts,
    syntheticMessages,
    emit(type: "session.created" | "session.moved" | "session.viewed", projectID = "project") {
      events.push({
        id: "event", created: Date.now(), durable: { aggregateID: "session", seq: 1, version: 1 },
        type,
        data: { sessionID: event.sessionID, projectID, location: { directory: sessionDirectory }, idle: 0, slug: "session", version: "2.1.0" },
      } as PublicEvent)
      wake?.()
    },
    subscriptionSignal: () => subscriptionSignal,
    setSession(directory: string, projectID = "project", parent?: string) {
      sessionDirectory = directory
      sessionProject = projectID
      parentID = parent
    },
    start,
    setMcpServer(server: Mcp.ServerConfig | undefined, status: Mcp.Status = { status: "connected" }) {
      mcpServer = server
      mcpStatus = status
      mcpTransform?.()
    },
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

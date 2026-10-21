import type { Plugin } from "@opencode/plugin"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"

const OPERATION_TIMEOUT_MS = 15_000
const ANALYSIS_TIMEOUT_MS = 10_000
const MAX_REPORT_CHARACTERS = 12_000

const STEPS = {
  formatting: {
    toolName: "rider_reformat_file",
    successStatus: "formatted",
    failureLabel: "Formatting",
    truncationLabel: "Formatting output",
  },
  diagnostics: {
    toolName: "rider_lint_files",
    successStatus: "checked",
    failureLabel: "Check",
    truncationLabel: "Diagnostics",
  },
} as const

export const RIDER_TOOL_NAMES = Object.values(STEPS).map(step => step.toolName)

export type StepName = keyof typeof STEPS
type ReportStatus = "formatted" | "checked" | "unavailable"

interface Report {
  step: StepName
  text: string
  files: string[]
  status: ReportStatus
}

export interface RiderRun {
  plugin: Plugin.Context
  call: Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id">
  tools: readonly (Info & { readonly id: string })[]
  projectPath?: string
  files: string[]
  omittedFileCount: number
  lifetime: AbortSignal
}

export function hasRiderTools(tools: RiderRun["tools"]): boolean {
  return RIDER_TOOL_NAMES.some(name => tools.some(tool => tool.id === name))
}

export function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "message" in error) {
    if (error.message !== undefined && error.message !== null) {
      return String(error.message)
    }
  }
  return String(error)
}

export function appendReport(result: Result, report: Report): Result {
  let content = result.content ?? []
  if (typeof content === "string") {
    content = [{ type: "text", text: content }]
  }

  const previousReports = result.metadata?.riderPostEdit
  const metadata = previousReports && typeof previousReports === "object"
    ? previousReports
    : {}

  return {
    ...result,
    content: [
      ...content,
      { type: "text", text: `Rider post-edit ${report.step}\n${report.text}` },
    ],
    metadata: {
      ...result.metadata,
      riderPostEdit: {
        ...metadata,
        files: report.files,
        status: report.status,
        [report.step]: { files: report.files, status: report.status },
      },
    },
  }
}

function reportText(result: Result, stepName: StepName): string {
  let text = ""
  if (typeof result.content === "string") {
    text = result.content
  } else if (result.content) {
    text = result.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
  }

  if (!text && result.output !== undefined) {
    text = JSON.stringify(result.output, null, 2)
  }
  if (!text) {
    text = `Rider returned no output; ${stepName} is not confirmed.`
  }

  return boundedReportText(text, stepName)
}

function boundedReportText(text: string, stepName: StepName): string {
  if (text.length <= MAX_REPORT_CHARACTERS) {
    return text
  }

  const step = STEPS[stepName]
  const truncatedText = text.slice(0, MAX_REPORT_CHARACTERS)
  return `${truncatedText}\n[${step.truncationLabel} truncated. Run ${step.toolName} for the full result.]`
}

function omittedFilesMessage(count: number, stepName: StepName): string {
  if (count === 0) {
    return ""
  }

  const step = STEPS[stepName]
  const subject = count === 1 ? "file was" : "files were"
  return `\n${count} additional ${subject} not ${step.successStatus}. Run ${step.toolName} for those files.`
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  lifetime: AbortSignal,
  milliseconds: number,
): Promise<T> {
  lifetime.throwIfAborted()

  const deadline = new AbortController()
  const signal = AbortSignal.any([lifetime, deadline.signal])
  const cancelled = Promise.withResolvers<never>()
  const onAbort = () => cancelled.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })

  const timer = setTimeout(() => {
    deadline.abort(new Error("Rider post-edit operation timed out."))
  }, milliseconds)

  try {
    // Attach cancellation handling before the operation can start or throw.
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return operation(signal)
    })
    return await Promise.race([work, cancelled.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

export async function runRiderStep(
  originalResult: Result,
  stepName: StepName,
  run: RiderRun,
): Promise<Result> {
  const step = STEPS[stepName]

  try {
    const tool = run.tools.find(tool => tool.id === step.toolName)
    if (!tool) {
      throw new Error(`${step.toolName} is unavailable. Check /mcps and keep the solution open in Rider.`)
    }

    await run.plugin.permission.assert({
      sessionID: run.call.sessionID,
      agent: run.call.agent,
      source: { type: "tool", messageID: run.call.messageID, id: run.call.id },
      action: step.toolName,
      resources: ["*"],
      metadata: { files: run.files, projectPath: run.projectPath },
    })

    // A scoped connection supplies its own selector. Otherwise let Rider select
    // the open project containing each file. Absolute paths avoid guessing the
    // selected project's base directory, which may differ from the checkout.
    const requests = run.projectPath
      ? [{ files: run.files }]
      : run.files.map(file => ({ files: [file], projectPath: file }))

    const report = await withDeadline(async signal => {
      const texts: string[] = []
      let failed = false
      for (const request of requests) {
        signal.throwIfAborted()
        const input = stepName === "formatting"
          ? request
          : { ...request, min_severity: "warning", timeout: ANALYSIS_TIMEOUT_MS }

        try {
          const result = await tool.execute(input, {
            ...run.call,
            signal,
            progress: async () => {},
          })
          signal.throwIfAborted()
          texts.push(reportText(result, stepName))
        } catch (error) {
          signal.throwIfAborted()
          failed = true
          texts.push(`${step.failureLabel} did not complete for ${request.files.join(", ")}: ${errorMessage(error)}`)
        }
      }
      return { text: boundedReportText(texts.join("\n"), stepName), failed }
    }, run.lifetime, OPERATION_TIMEOUT_MS)

    return appendReport(originalResult, {
      step: stepName,
      text: report.text + omittedFilesMessage(run.omittedFileCount, stepName),
      files: run.files,
      status: report.failed ? "unavailable" : step.successStatus,
    })
  } catch (error) {
    // Each step handles its own failure so diagnostics can follow a failed format.
    return appendReport(originalResult, {
      step: stepName,
      text: `${step.failureLabel} did not complete: ${errorMessage(error)}`,
      files: run.files,
      status: "unavailable",
    })
  }
}

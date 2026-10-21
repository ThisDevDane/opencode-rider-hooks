import { realpath } from "node:fs/promises"
import { Plugin, type Mcp } from "@opencode/plugin"
import { changedPaths, isCSharpFile, isInsideDirectory, sourceFiles } from "./files.ts"
import { configuredProjectPath, projectDirectory } from "./projects.ts"
import { appendReport, errorMessage, hasRiderTools, runRiderStep, type RiderRun } from "./rider.ts"
import { riderStatus } from "./status.ts"

const MAX_FILES_PER_EDIT = 20

export async function register(plugin: Plugin.Context, repositoryRoot: string) {
  const checkoutRoot = await realpath(repositoryRoot)
  const lifetime = new AbortController()
  let riderServer: Mcp.ServerConfig | undefined

  // Read OpenCode's merged MCP configuration without parsing configuration files.
  await plugin.mcp.transform(editor => {
    riderServer = editor.get("rider")
  })

  await plugin.command.transform(editor => {
    editor.add({
      name: "rider-status",
      description: "Check Rider hooks setup and MCP availability without changing files",
      async execute({ sessionID, delivery }) {
        const text = await riderStatus(plugin, sessionID, checkoutRoot, riderServer)
        await plugin.session.synthetic({ sessionID, text, delivery, resume: false })
      },
    })
  })

  await plugin.tool.hook("execute.after", async event => {
    if (event.status !== "completed") {
      return
    }

    const paths = changedPaths(event.tool, event.input, event.result)
    if (!paths.some(isCSharpFile)) {
      return
    }

    let files: string[] = []
    try {
      const tools = await plugin.tool.list()
      if (!hasRiderTools(tools)) {
        return
      }

      const session = await plugin.session.get({ sessionID: event.sessionID })
      const workingDirectory = await realpath(session.location.directory)
      if (!isInsideDirectory(checkoutRoot, workingDirectory)) {
        return
      }

      const selector = configuredProjectPath(riderServer)
      const root = selector ? await projectDirectory(selector, checkoutRoot) : checkoutRoot
      files = (await sourceFiles(paths, workingDirectory, checkoutRoot))
        .filter(file => isInsideDirectory(root, file))
      if (files.length === 0) {
        return
      }

      const selectedFiles = files.slice(0, MAX_FILES_PER_EDIT)
      const run: RiderRun = {
        plugin,
        call: {
          sessionID: event.sessionID,
          agent: event.agent,
          messageID: event.messageID,
          id: event.id,
        },
        tools,
        projectPath: selector,
        files: selectedFiles,
        omittedFileCount: files.length - selectedFiles.length,
        lifetime: lifetime.signal,
      }

      event.result = await runRiderStep(event.result, "formatting", run)
      event.result = await runRiderStep(event.result, "diagnostics", run)
    } catch (error) {
      // Post-edit failures must not hide the original successful edit.
      event.result = appendReport(event.result, {
        step: "diagnostics",
        text: `Check skipped: ${errorMessage(error)}`,
        files,
        status: "unavailable",
      })
    }
  })

  return () => lifetime.abort()
}

export default Plugin.define({
  id: "opencode-rider-hooks",
  setup: plugin => register(plugin, plugin.location.project.canonical),
})

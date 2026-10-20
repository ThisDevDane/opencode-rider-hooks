import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { changedPaths, isCSharpFile, isInsideDirectory, solutionFiles } from "./files.ts"
import { appendReport, errorMessage, runRiderStep, type RiderRun } from "./rider.ts"

const MAX_FILES_PER_EDIT = 20

export async function register(plugin: Plugin.Context, repositoryRoot: string) {
  const checkoutRoot = await realpath(repositoryRoot)
  const solutionRoot = await realpath(resolve(checkoutRoot, "src"))
  const lifetime = new AbortController()

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
      const session = await plugin.session.get({ sessionID: event.sessionID })
      const workingDirectory = await realpath(session.location.directory)
      if (!isInsideDirectory(checkoutRoot, workingDirectory)) {
        return
      }

      files = await solutionFiles(paths, workingDirectory, solutionRoot)
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
        tools: await plugin.tool.list(),
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
  id: "local.rider-post-edit",
  setup: plugin => register(plugin, plugin.location.project.canonical),
})

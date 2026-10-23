import { spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Mcp } from "@opencode/plugin"
import { isInsideDirectory } from "./files.ts"
import { configuredProjectPath } from "./projects.ts"

export interface WorktreeOptions {
  openWorktrees: boolean
  worktreeProject: string
  riderCommand?: string[]
}

export function worktreeOptions(options: Record<string, unknown>): WorktreeOptions {
  if (options.openWorktrees !== undefined && typeof options.openWorktrees !== "boolean") {
    throw new Error("openWorktrees must be a boolean.")
  }
  if (options.worktreeProject !== undefined
    && (typeof options.worktreeProject !== "string" || !options.worktreeProject.trim())) {
    throw new Error("worktreeProject must be a non-empty relative path.")
  }
  if (options.riderCommand !== undefined
    && (!Array.isArray(options.riderCommand) || options.riderCommand.length === 0
      || !options.riderCommand.every(value => typeof value === "string" && value.trim()))) {
    throw new Error("riderCommand must be a non-empty array of command arguments.")
  }
  return {
    openWorktrees: options.openWorktrees === true,
    worktreeProject: options.worktreeProject as string | undefined ?? ".",
    riderCommand: options.riderCommand as string[] | undefined,
  }
}

export function worktreeConflict(options: WorktreeOptions, server: Mcp.ServerConfig | undefined): string | undefined {
  if (options.openWorktrees && configuredProjectPath(server)) {
    return "openWorktrees and IJ_MCP_SERVER_PROJECT_PATH are mutually exclusive. Remove the Rider project selector or disable openWorktrees."
  }
}

export async function worktreeTarget(checkoutRoot: string, project: string): Promise<string> {
  const target = resolve(checkoutRoot, project)
  if (isAbsolute(project) || !isInsideDirectory(checkoutRoot, target)) {
    throw new Error("worktreeProject must be relative to and stay inside the worktree.")
  }
  const path = await realpath(target)
  if (!isInsideDirectory(checkoutRoot, path)) {
    throw new Error("worktreeProject points outside the worktree.")
  }
  const info = await stat(path)
  if (!info.isDirectory() && !(info.isFile() && /\.(?:slnx?|csproj|fsproj|vbproj)$/i.test(path))) {
    throw new Error("worktreeProject must name a directory, solution, or .NET project.")
  }
  return path
}

export function riderCommand(options: WorktreeOptions, platform: NodeJS.Platform): string[] {
  if (options.riderCommand) {
    return options.riderCommand
  }
  if (platform === "darwin") {
    return ["/usr/bin/open", "-a", "Rider"]
  }
  if (platform === "win32") {
    return ["rider64.exe"]
  }
  throw new Error("Automatic Rider launching requires macOS or Windows, or an explicit riderCommand.")
}

export async function launchRider(
  target: string,
  options: WorktreeOptions,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  signal.throwIfAborted()
  const [command, ...args] = riderCommand(options, platform)
  // Never interpolate the worktree path into a shell command.
  const child = spawnProcess(command, [...args, target], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  })
  let onAbort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
      }
      child.once("error", reject)
      if (platform === "darwin" && !options.riderCommand) {
        // `open` exits immediately, unlike the Windows IDE process. Observe its
        // exit status so a missing macOS application is not reported as success.
        child.once("exit", code => code === 0
          ? resolve()
          : reject(new Error(`Rider launcher exited with code ${code}. Check riderCommand.`)))
      } else {
        child.once("spawn", resolve)
      }
    })
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
    // Rider must survive plugin unload and must not keep OpenCode running.
    child.unref()
  }
}

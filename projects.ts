import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import type { Mcp } from "@opencode/plugin"
import { isInsideDirectory } from "./files.ts"

const PROJECT_PATH = "IJ_MCP_SERVER_PROJECT_PATH"

export function configuredProjectPath(
  server: Mcp.ServerConfig | undefined,
  inheritedEnvironment: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!server || server.disabled) {
    return undefined
  }

  const path = server.type === "local"
    ? server.environment?.[PROJECT_PATH] ?? inheritedEnvironment[PROJECT_PATH]
    : Object.entries(server.headers ?? {})
      .find(([name]) => name.toUpperCase() === PROJECT_PATH)?.[1]

  return path?.trim() || undefined
}

export async function projectDirectory(selector: string, checkoutRoot: string): Promise<string> {
  const path = selector.startsWith("file:") ? fileURLToPath(selector) : selector
  if (!isAbsolute(path)) {
    throw new Error(`${PROJECT_PATH} must name an absolute project path.`)
  }

  const directory = await realpath(path)
  if (!isInsideDirectory(checkoutRoot, directory)) {
    throw new Error(`${PROJECT_PATH} points outside this checkout.`)
  }
  return (await stat(directory)).isDirectory() ? directory : dirname(directory)
}

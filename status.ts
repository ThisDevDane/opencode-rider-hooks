import { realpath } from "node:fs/promises"
import type { Mcp, Plugin } from "@opencode/plugin"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import { isInsideDirectory } from "./files.ts"
import { configuredProjectPath, projectDirectory } from "./projects.ts"
import { errorMessage, RIDER_TOOL_NAMES } from "./rider.ts"

export async function riderStatus(
  plugin: Plugin.Context,
  sessionID: CommandInvocation["sessionID"],
  checkoutRoot: string,
  server: Mcp.ServerConfig | undefined,
): Promise<string> {
  const lines = [
    "Rider hooks status",
    "Plugin: opencode-rider-hooks is loaded.",
    `Checkout: ${checkoutRoot}`,
  ]
  let ready = true

  try {
    const session = await plugin.session.get({ sessionID })
    const directory = await realpath(session.location.directory)
    lines.push(`Session directory: ${directory}`)
    if (!isInsideDirectory(checkoutRoot, directory)) {
      ready = false
      lines.push("Session is outside this checkout; post-edit checks are skipped.")
    }
  } catch (error) {
    ready = false
    lines.push(`Session directory could not be checked: ${errorMessage(error)}`)
  }

  if (!server) {
    ready = false
    lines.push('MCP configuration: missing. Configure a server named "rider" in mcp.servers.')
  } else if (server.disabled) {
    ready = false
    lines.push('MCP configuration: disabled. Enable the "rider" server in mcp.servers.')
  } else {
    lines.push(`MCP configuration: rider is enabled, ${server.type} transport.`)
    const selector = configuredProjectPath(server)
    if (selector) {
      lines.push(`Project selector: ${selector}`)
      try {
        lines.push(`Project directory: ${await projectDirectory(selector, checkoutRoot)}`)
      } catch (error) {
        ready = false
        lines.push(`Project selector is invalid: ${errorMessage(error)}`)
      }
    } else {
      lines.push("Project selection: automatic. Rider resolves each changed file against its open projects.")
    }
  }

  try {
    const servers = await plugin.mcp.list()
    const status = servers.data.find(server => server.name === "rider")?.status
    if (status?.status === "connected") {
      lines.push("Rider connection: connected.")
    } else {
      ready = false
      lines.push(`Rider connection: ${status?.status ?? "not listed"}. Check /mcps and keep the project open in Rider.`)
      if (status?.status === "needs_auth") {
        lines.push("Select rider in /mcps and sign in.")
      }
    }
  } catch {
    ready = false
    lines.push("Rider connection could not be read. Check /mcps.")
  }

  try {
    const tools = await plugin.tool.list()
    for (const name of RIDER_TOOL_NAMES) {
      const available = tools.some(tool => tool.id === name)
      lines.push(`${name}: ${available ? "available" : "missing"}.`)
      ready &&= available
    }
    if (RIDER_TOOL_NAMES.some(name => !tools.some(tool => tool.id === name))) {
      lines.push("Check /mcps and enable the missing tools in Rider's MCP settings.")
    }
  } catch {
    ready = false
    lines.push("Rider tool availability could not be read. Check /mcps.")
  }

  lines.push(
    "",
    ready ? "Setup: ready for post-edit checks." : "Setup: needs attention.",
    "No Rider tools were executed. Permissions and open-project matching are not verified by this command.",
  )
  return lines.join("\n")
}

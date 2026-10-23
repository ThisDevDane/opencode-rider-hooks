import { realpath } from "node:fs/promises"
import type { Mcp, Plugin } from "@opencode/plugin"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import { isInsideDirectory } from "./files.ts"
import { errorMessage, withDeadline } from "./rider.ts"
import { launchRider, worktreeConflict, worktreeTarget, type WorktreeOptions } from "./worktrees.ts"

const LAUNCH_TIMEOUT_MS = 5000
interface SharedLaunch {
  promise: Promise<void>
  controller: AbortController
  owners: Set<AbortSignal>
  finished: boolean
}
const launches = new Map<string, SharedLaunch>()

export function requestRiderLaunch(
  target: string,
  options: WorktreeOptions,
  lifetime: AbortSignal,
  launch: typeof launchRider = launchRider,
): Promise<void> {
  lifetime.throwIfAborted()
  let shared = launches.get(target)
  if (!shared || shared.controller.signal.aborted) {
    const controller = new AbortController()
    const promise = withDeadline(
      signal => launch(target, options, signal),
      controller.signal,
      LAUNCH_TIMEOUT_MS,
      "Rider launch request timed out.",
    )
    shared = { promise, controller, owners: new Set(), finished: false }
    launches.set(target, shared)
    const entry = shared
    void promise.then(
      () => { entry.finished = true },
      () => {
        entry.finished = true
        if (launches.get(target) === entry) launches.delete(target)
      },
    )
  }

  const entry = shared
  entry.owners.add(lifetime)
  const release = () => {
    entry.owners.delete(lifetime)
    if (!entry.finished && entry.owners.size === 0) {
      entry.controller.abort(new Error("Rider launch no longer has an active plugin instance."))
    }
  }
  lifetime.addEventListener("abort", release, { once: true })
  return entry.promise.finally(() => {
    lifetime.removeEventListener("abort", release)
    release()
  })
}

export interface WorktreeOpening {
  status(): { text: string; ready: boolean }
}

export async function registerWorktreeOpening(
  plugin: Plugin.Context,
  checkoutRoot: string,
  options: WorktreeOptions,
  server: () => Mcp.ServerConfig | undefined,
  lifetime: AbortSignal,
  launch: typeof launchRider = launchRider,
): Promise<WorktreeOpening> {
  const linked = options.openWorktrees
    && checkoutRoot !== await realpath(plugin.location.project.canonical)
  let attempt: Promise<void> | undefined
  let target: string | undefined
  let requested = false
  let failure: string | undefined

  async function matches(sessionID: string): Promise<boolean> {
    const session = await plugin.session.get({ sessionID: sessionID as SessionPrompt["sessionID"] }, { signal: lifetime })
    const directory = await realpath(session.location.directory)
    return session.projectID === plugin.location.project.id && !session.parentID
      && isInsideDirectory(checkoutRoot, directory)
  }

  async function ensure(sessionID: string) {
    if (lifetime.aborted || attempt || worktreeConflict(options, server())) return
    const connection = server()
    if (!connection || connection.disabled) return

    try {
      // Events are server-wide and can be stale after a subsequent session move.
      if (!await matches(sessionID) || lifetime.aborted || attempt) return

      attempt = (async () => {
        target = await worktreeTarget(checkoutRoot, options.worktreeProject)
        // The session may have moved again while resolving the launch target.
        if (!await matches(sessionID)) {
          attempt = undefined
          return
        }
        lifetime.throwIfAborted()
        // Recheck merged configuration immediately before starting a process.
        const conflict = worktreeConflict(options, server())
        if (conflict) throw new Error(conflict)
        const current = server()
        if (!current || current.disabled) throw new Error('The "rider" MCP server is missing or disabled.')

        await requestRiderLaunch(target, options, lifetime, launch)
        requested = !lifetime.aborted
        failure = undefined
      })()
      await attempt
    } catch (error) {
      if (!lifetime.aborted) failure = errorMessage(error)
    }
  }

  if (linked) {
    async function existingSession() {
      if (worktreeConflict(options, server()) || !server() || server()?.disabled) return
      let cursor: string | undefined
      do {
        const page = await plugin.session.list({ project: plugin.location.project.id, limit: 100, cursor }, { signal: lifetime })
        for (const session of page.data) {
          if (lifetime.aborted || attempt) return
          if (!session.parentID && isInsideDirectory(checkoutRoot, session.location.directory)) {
            await ensure(session.id)
          }
        }
        cursor = page.cursor.next ?? undefined
      } while (cursor && !lifetime.aborted && !attempt)
    }

    // Keep slow session lookups and process startup out of event consumption.
    void (async () => {
      for await (const event of plugin.event.subscribe({ signal: lifetime })) {
        if (event.type === "session.created" || event.type === "session.moved") {
          if (event.data.projectID === plugin.location.project.id) void ensure(event.data.sessionID)
        } else if (event.type === "session.viewed") {
          void ensure(event.data.sessionID)
        }
      }
    })().catch(error => {
      if (!lifetime.aborted) failure = `Session event subscription failed: ${errorMessage(error)}`
    })

    // Subscribe before reading existing sessions so plugin activation after a
    // create/view event is covered without launching every historical worktree.
    void existingSession().catch(error => {
      if (!lifetime.aborted) failure = `Existing sessions could not be checked: ${errorMessage(error)}`
    })

    // A new location's plugin can load after the session's creation event.
    // Prompt admission is a fallback, not an exactly-once side-effect boundary.
    await plugin.session.hook("prompt", async event => {
      if (!event.metadata?.riderStatus) await ensure(event.sessionID)
    })
  }

  return {
    status() {
      const conflict = worktreeConflict(options, server())
      if (conflict) return { text: `Worktree auto-open: blocked. ${conflict}`, ready: false }
      if (!options.openWorktrees) return { text: "Worktree auto-open: disabled.", ready: true }
      if (!linked) return { text: "Worktree auto-open: enabled. This is the canonical checkout; Rider is not launched here.", ready: true }
      if (failure) return { text: `Worktree auto-open: failed. ${failure} Reload the plugin to retry, or open Rider manually.`, ready: false }
      if (requested) return { text: `Worktree auto-open: launch requested for ${target}. Rider readiness is not verified.`, ready: true }
      if (attempt) return { text: `Worktree auto-open: launching ${target ?? checkoutRoot}.`, ready: true }
      return { text: "Worktree auto-open: waiting for a session to be created, moved, viewed, or prompted in this checkout.", ready: true }
    },
  }
}

import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { setTimeout } from "node:timers/promises"
import type { Mcp } from "@opencode/plugin"
import { requestRiderLaunch } from "../opening.ts"
import { worktreeOptions } from "../worktrees.ts"
import { createFixture, getReportText } from "./fake-opencode.ts"

let root: string
let canonicalRoot: string
let checkout: string
const server: Mcp.ServerConfig = { type: "remote", url: "http://localhost:64342/stream" }

beforeEach(async () => {
  const temporaryRoot = join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  root = await realpath(await mkdtemp(join(temporaryRoot, "rider-opening-")))
  canonicalRoot = join(root, "main")
  checkout = join(root, "feature")
  await mkdir(canonicalRoot)
  await mkdir(join(checkout, "App"), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await setTimeout(5)
  assert.equal(check(), true, "Expected asynchronous session event handling to finish")
}

function fixture(options: Parameters<typeof createFixture>[1] = {}) {
  const requests: string[] = []
  const instance = createFixture(checkout, {
    canonicalRoot,
    mcpServer: server,
    pluginOptions: { openWorktrees: true },
    launch: async target => { requests.push(target) },
    ...options,
  })
  return { instance, requests }
}

describe("worktree auto-open lifecycle", () => {
  test("does not subscribe or launch without opt-in", async () => {
    const { instance, requests } = fixture({ pluginOptions: {} })
    const hook = await instance.start()
    try {
      await hook.runPrompt()
      assert.equal(instance.subscriptionSignal(), undefined)
      assert.deepEqual(requests, [])
      await hook.runCommand()
      assert.match(instance.prompts[0].text, /Worktree auto-open: disabled/)
    } finally { hook.cleanup() }
  })

  test("does not launch in the canonical checkout", async () => {
    const { instance, requests } = fixture({ canonicalRoot: checkout })
    const hook = await instance.start()
    try {
      await hook.runPrompt()
      assert.equal(instance.subscriptionSignal(), undefined)
      assert.deepEqual(requests, [])
      await hook.runCommand()
      assert.match(instance.prompts[0].text, /canonical checkout; Rider is not launched here/)
    } finally { hook.cleanup() }
  })

  for (const type of ["session.created", "session.moved", "session.viewed"] as const) {
    test(`opens the current worktree on ${type} and deduplicates later events`, async () => {
      const { instance, requests } = fixture({ workingDirectory: join(checkout, "App") })
      const hook = await instance.start()
      try {
        instance.emit(type)
        await waitFor(() => requests.length === 1)
        assert.deepEqual(requests, [checkout])
        instance.emit("session.created")
        instance.emit("session.moved")
        instance.emit("session.viewed")
        await hook.runPrompt()
        assert.deepEqual(requests, [checkout])
        await hook.runCommand()
        assert.match(instance.prompts[0].text, /launch requested/)
        assert.match(instance.prompts[0].text, /Rider readiness is not verified/)
      } finally { hook.cleanup() }
    })
  }

  test("covers a session that existed before the worktree's plugin loaded", async () => {
    const { instance, requests } = fixture({ existingSession: true })
    const hook = await instance.start()
    try {
      await waitFor(() => requests.length === 1)
      assert.deepEqual(requests, [checkout])
    } finally { hook.cleanup() }
  })

  test("uses first prompt admission if the session event was missed", async () => {
    const { instance, requests } = fixture()
    const hook = await instance.start()
    try {
      await hook.runPrompt()
      assert.deepEqual(requests, [checkout])
    } finally { hook.cleanup() }
  })

  test("status reports do not trigger a launch through prompt admission", async () => {
    const { instance, requests } = fixture()
    const hook = await instance.start()
    try {
      await hook.runCommand()
      assert.deepEqual(instance.prompts[0].metadata, { riderStatus: true })
      await hook.runPrompt(instance.prompts[0].metadata)
      assert.deepEqual(requests, [])
      assert.match(instance.prompts[0].text, /Worktree auto-open: waiting/)
    } finally { hook.cleanup() }
  })

  test("deduplicates concurrent events and nested plugin instances for one target", async () => {
    const first = fixture()
    const second = fixture({ workingDirectory: join(checkout, "App") })
    const hooks = await Promise.all([first.instance.start(), second.instance.start()])
    try {
      await Promise.all([hooks[0].runPrompt(), hooks[0].runPrompt(), hooks[1].runPrompt()])
      assert.equal(first.requests.length + second.requests.length, 1)
    } finally { for (const hook of hooks) hook.cleanup() }
  })

  test("selects an explicit solution relative to the worktree", async () => {
    const solution = join(checkout, "App", "App.slnx")
    await writeFile(solution, "")
    const { instance, requests } = fixture({ pluginOptions: { openWorktrees: true, worktreeProject: "App/App.slnx" } })
    const hook = await instance.start()
    try {
      await hook.runPrompt()
      assert.deepEqual(requests, [solution])
    } finally { hook.cleanup() }
  })

  test("ignores other checkouts, projects, child sessions, and stale move events", async () => {
    const { instance, requests } = fixture()
    const hook = await instance.start()
    try {
      instance.setSession(canonicalRoot)
      instance.emit("session.moved")
      await hook.runPrompt()
      instance.setSession(checkout, "other-project")
      await hook.runPrompt()
      instance.setSession(checkout, "project", "parent-session")
      await hook.runPrompt()
      assert.deepEqual(requests, [])
    } finally { hook.cleanup() }
  })

  test("revalidates a session that moves away during target resolution", async () => {
    const checking = Promise.withResolvers<void>()
    const continueCheck = Promise.withResolvers<void>()
    const { instance, requests } = fixture({ onSessionGet: async count => {
      if (count === 2) {
        checking.resolve()
        await continueCheck.promise
      }
    } })
    const hook = await instance.start()
    try {
      const prompt = hook.runPrompt()
      await checking.promise
      instance.setSession(canonicalRoot)
      continueCheck.resolve()
      await prompt
      assert.deepEqual(requests, [])
      instance.setSession(checkout)
      await hook.runPrompt()
      assert.deepEqual(requests, [checkout])
    } finally { hook.cleanup() }
  })

  test("one instance's cleanup cannot cancel another instance's shared launch", async () => {
    const first = new AbortController()
    const second = new AbortController()
    const started = Promise.withResolvers<AbortSignal>()
    const finish = Promise.withResolvers<void>()
    let attempts = 0
    const launch = async (_target: string, _options: unknown, signal: AbortSignal) => {
      attempts++
      started.resolve(signal)
      await finish.promise
    }
    const options = worktreeOptions({ openWorktrees: true })
    const one = requestRiderLaunch(checkout, options, first.signal, launch)
    const two = requestRiderLaunch(checkout, options, second.signal, launch)
    const signal = await started.promise
    first.abort()
    assert.equal(signal.aborted, false)
    finish.resolve()
    await Promise.all([one, two])
    assert.equal(attempts, 1)
  })

  test("cancels an unowned pending launch and permits a later retry", async () => {
    const owner = new AbortController()
    const started = Promise.withResolvers<AbortSignal>()
    const options = worktreeOptions({ openWorktrees: true })
    const pending = requestRiderLaunch(checkout, options, owner.signal, async (_target, _options, signal) => {
      started.resolve(signal)
      await new Promise<void>(() => {})
    })
    const signal = await started.promise
    owner.abort()
    await assert.rejects(pending, /no longer has an active plugin/)
    assert.equal(signal.aborted, true)
    let retried = false
    await requestRiderLaunch(checkout, options, new AbortController().signal, async () => { retried = true })
    assert.equal(retried, true)
  })

  test("does not launch with a missing or disabled Rider MCP server", async () => {
    for (const mcpServer of [undefined, { ...server, disabled: true }]) {
      const { instance, requests } = fixture({ mcpServer })
      const hook = await instance.start()
      try {
        await hook.runPrompt()
        assert.deepEqual(requests, [])
        instance.setMcpServer(server)
        await hook.runPrompt()
        // Targets are deduplicated across plugin instances in the same service.
      } finally { hook.cleanup() }
    }
  })

  test("fails closed for a selector conflict and picks up a corrected configuration", async () => {
    const { instance, requests } = fixture({
      mcpServer: { ...server, headers: { ij_mcp_server_project_path: checkout } },
    })
    const hook = await instance.start()
    try {
      await hook.runPrompt()
      assert.deepEqual(requests, [])
      await hook.runCommand()
      assert.match(instance.prompts[0].text, /Worktree auto-open: blocked.*mutually exclusive/)
      assert.match(instance.prompts[0].text, /Setup: needs attention/)
      await hook.run()
      assert.deepEqual(instance.formatRequests, [])
      assert.deepEqual(instance.diagnosticRequests, [])
      assert.deepEqual(instance.permissionActions, [])
      assert.match(getReportText(instance.event.result, "diagnostics"), /mutually exclusive/)

      instance.setMcpServer(server)
      await hook.runPrompt()
      assert.deepEqual(requests, [checkout])
      instance.setMcpServer({ ...server, headers: { IJ_MCP_SERVER_PROJECT_PATH: checkout } })
      await hook.runCommand()
      assert.match(instance.prompts[1].text, /Worktree auto-open: blocked/)
    } finally { hook.cleanup() }
  })

  test("reports launch failures without rejecting prompts or retrying on every prompt", async () => {
    let attempts = 0
    const { instance } = fixture({ launch: async () => { attempts++; throw new Error("Rider not found") } })
    const hook = await instance.start()
    try {
      await assert.doesNotReject(hook.runPrompt())
      await hook.runPrompt()
      assert.equal(attempts, 1)
      await hook.runCommand()
      assert.match(instance.prompts[0].text, /Worktree auto-open: failed.*Rider not found/)
      assert.match(instance.prompts[0].text, /Setup: needs attention/)
    } finally { hook.cleanup() }
    const retry = fixture()
    const retryHook = await retry.instance.start()
    try {
      await retryHook.runPrompt()
      assert.deepEqual(retry.requests, [checkout])
    } finally { retryHook.cleanup() }
  })

  test("invalid launch targets never start a process", async () => {
    const { instance, requests } = fixture({ pluginOptions: { openWorktrees: true, worktreeProject: "../main" } })
    const hook = await instance.start()
    try {
      await hook.runPrompt()
      assert.deepEqual(requests, [])
      await hook.runCommand()
      assert.match(instance.prompts[0].text, /Worktree auto-open: failed.*stay inside the worktree/)
    } finally { hook.cleanup() }
  })

  test("unloading aborts subscription and prevents later launches", async () => {
    const { instance, requests } = fixture()
    const hook = await instance.start()
    hook.cleanup()
    assert.equal(instance.subscriptionSignal()?.aborted, true)
    instance.emit("session.created")
    await hook.runPrompt()
    assert.deepEqual(requests, [])
  })
})

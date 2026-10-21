import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { setImmediate } from "node:timers/promises"
import type { Result, ToolContext } from "@opencode/plugin/promise/tool"
import { runRiderStep, type RiderRun, type StepName } from "../rider.ts"
import { getReportText } from "./fake-opencode.ts"

const MEMBERSHIP_ERROR = "Requested files are not part of the current solution."
const RETRY_DELAYS = [250, 500, 1000, 2000]

function createRun(
  execute: (input: unknown, context: ToolContext, attempt: number) => Promise<Result>,
  step: StepName = "formatting",
) {
  const requests: { input: unknown; signal: AbortSignal }[] = []
  const permissionActions: string[] = []
  const lifetime = new AbortController()
  const run = {
    plugin: {
      permission: {
        async assert({ action }: { action: string }) { permissionActions.push(action) },
      },
    },
    call: { sessionID: "session", agent: "build", messageID: "message", id: "call" },
    tools: [{
      id: step === "formatting" ? "rider_reformat_file" : "rider_lint_files",
      async execute(input: unknown, context: ToolContext) {
        requests.push({ input, signal: context.signal })
        return await execute(input, context, requests.length)
      },
    }],
    files: ["/checkout/New.cs"],
    omittedFileCount: 0,
    lifetime: lifetime.signal,
  } as unknown as RiderRun

  return { run, requests, permissionActions, lifetime }
}

describe("solution synchronization retries", () => {
  test("backs off without resetting the deadline or requesting permission again", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const fixture = createRun(async (_input, _context, attempt) => {
      if (attempt <= RETRY_DELAYS.length) {
        throw new Error(`MCP error: ${MEMBERSHIP_ERROR}`)
      }
      return { content: "formatter diff" }
    })
    const pending = runRiderStep({ content: "Edit succeeded" }, "formatting", fixture.run)
    await setImmediate()
    assert.equal(fixture.requests.length, 1)

    for (const [index, milliseconds] of RETRY_DELAYS.entries()) {
      t.mock.timers.tick(milliseconds - 1)
      await setImmediate()
      assert.equal(fixture.requests.length, index + 1)
      t.mock.timers.tick(1)
      await setImmediate()
      assert.equal(fixture.requests.length, index + 2)
    }

    const result = await pending
    assert.equal(new Set(fixture.requests.map(request => request.signal)).size, 1)
    assert.ok(fixture.requests.every(request => request.input === fixture.requests[0].input))
    assert.deepEqual(fixture.permissionActions, ["rider_reformat_file"])
    assert.ok(getReportText(result, "formatting").includes("succeeded after 4 retries"))
    assert.ok(getReportText(result, "formatting").includes("formatter diff"))
    assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { formatting: { status: "formatted" } } })
  })

  test("bounds retries for files that remain outside the solution and continues other files", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const fixture = createRun(async (_input, _context, attempt) => {
      if (attempt <= 5) {
        throw new Error(MEMBERSHIP_ERROR)
      }
      return { content: "other file formatted" }
    })
    fixture.run.files.push("/checkout/Other.cs")
    const original = { content: "Edit succeeded", metadata: { saved: true } }
    const pending = runRiderStep(original, "formatting", fixture.run)
    await setImmediate()
    for (const milliseconds of RETRY_DELAYS) {
      t.mock.timers.tick(milliseconds)
      await setImmediate()
    }

    const result = await pending
    assert.equal(fixture.requests.length, 6)
    assert.deepEqual(fixture.requests[5].input, {
      files: ["/checkout/Other.cs"], projectPath: "/checkout/Other.cs",
    })
    const report = getReportText(result, "formatting")
    assert.ok(report.includes(MEMBERSHIP_ERROR))
    assert.ok(report.includes("Still rejected after 4 retries"))
    assert.ok(report.includes("included in the open Rider solution"))
    assert.ok(report.includes("other file formatted"))
    assert.deepEqual(result.content?.[0], { type: "text", text: "Edit succeeded" })
    assert.partialDeepStrictEqual(result.metadata, {
      saved: true, riderPostEdit: { formatting: { status: "unavailable" } },
    })
  })

  test("keeps configured connections scoped during batch retries", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const fixture = createRun(async (_input, _context, attempt) => {
      if (attempt === 1) {
        throw new Error(MEMBERSHIP_ERROR)
      }
      return { content: "ok" }
    })
    fixture.run.projectPath = "/checkout"
    fixture.run.files.push("/checkout/Other.cs")
    const pending = runRiderStep({}, "formatting", fixture.run)
    await setImmediate()
    t.mock.timers.tick(250)
    const result = await pending

    assert.deepEqual(fixture.requests.map(request => request.input), [
      { files: ["/checkout/New.cs", "/checkout/Other.cs"] },
      { files: ["/checkout/New.cs", "/checkout/Other.cs"] },
    ])
    assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { formatting: { status: "formatted" } } })
  })

  test("cancels a pending retry when the plugin unloads", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const fixture = createRun(async () => { throw new Error(MEMBERSHIP_ERROR) })
    const pending = runRiderStep({}, "formatting", fixture.run)
    await setImmediate()
    fixture.lifetime.abort(new Error("Plugin unloaded"))

    const result = await pending
    t.mock.timers.tick(15_000)
    await setImmediate()
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.requests[0].signal.aborted, true)
    assert.ok(getReportText(result, "formatting").includes("Plugin unloaded"))
    assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { formatting: { status: "unavailable" } } })
  })

  test("counts backoff against the shared step deadline", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const fixture = createRun(async () => { throw new Error(MEMBERSHIP_ERROR) })
    fixture.run.files.push("/checkout/Second.cs", "/checkout/Third.cs", "/checkout/Fourth.cs")
    const pending = runRiderStep({}, "formatting", fixture.run)
    await setImmediate()

    for (let file = 0; file < 4; file++) {
      for (const milliseconds of RETRY_DELAYS) {
        t.mock.timers.tick(milliseconds)
        await setImmediate()
      }
    }

    const result = await pending
    assert.equal(fixture.requests.length, 19)
    assert.ok(fixture.requests.every(request => request.signal.aborted))
    assert.ok(getReportText(result, "formatting").includes("timed out"))
    assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { formatting: { status: "unavailable" } } })
  })

  for (const message of ["Rider formatter failed", "Rider operation timed out", "Unable to determine the target project"]) {
    test(`does not retry other formatting errors: ${message}`, async () => {
      const fixture = createRun(async () => { throw new Error(message) })
      const result = await runRiderStep({}, "formatting", fixture.run)

      assert.equal(fixture.requests.length, 1)
      assert.ok(getReportText(result, "formatting").includes(message))
      assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { formatting: { status: "unavailable" } } })
    })
  }

  test("stops retrying if the formatter returns a different error", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const fixture = createRun(async (_input, _context, attempt) => {
      throw new Error(attempt === 1 ? MEMBERSHIP_ERROR : "Rider operation timed out")
    })
    const pending = runRiderStep({}, "formatting", fixture.run)
    await setImmediate()
    t.mock.timers.tick(250)
    const result = await pending

    assert.equal(fixture.requests.length, 2)
    assert.ok(getReportText(result, "formatting").includes("Rider operation timed out"))
    assert.ok(!getReportText(result, "formatting").includes("formatting succeeded"))
    assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { formatting: { status: "unavailable" } } })
  })

  test("does not interpret text in a successful formatter diff as a rejection", async () => {
    const fixture = createRun(async () => ({ content: `+// ${MEMBERSHIP_ERROR}` }))
    const result = await runRiderStep({}, "formatting", fixture.run)

    assert.equal(fixture.requests.length, 1)
    assert.ok(getReportText(result, "formatting").includes(`+// ${MEMBERSHIP_ERROR}`))
    assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { formatting: { status: "formatted" } } })
  })

  test("does not retry diagnostics on a solution-membership error", async () => {
    const fixture = createRun(async () => { throw new Error(MEMBERSHIP_ERROR) }, "diagnostics")
    const result = await runRiderStep({}, "diagnostics", fixture.run)

    assert.equal(fixture.requests.length, 1)
    assert.ok(getReportText(result, "diagnostics").includes(MEMBERSHIP_ERROR))
    assert.partialDeepStrictEqual(result.metadata, { riderPostEdit: { diagnostics: { status: "unavailable" } } })
  })
})

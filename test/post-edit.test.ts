import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { changedPaths, solutionFiles } from "../files.ts"
import { appendReport, withDeadline } from "../rider.ts"
import { createFixture, getReportText } from "./fake-opencode.ts"

let repositoryRoot: string

async function createFile(path: string, contents = "") {
  const absolutePath = join(repositoryRoot, path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)
}

beforeEach(async () => {
  const temporaryRoot = join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  repositoryRoot = await realpath(await mkdtemp(join(temporaryRoot, "rider-post-edit-")))
  await createFile("src/App/Example.cs", "class Example {}")
})

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true })
})

describe("changed files", () => {
  test("uses patch metadata, skips deletions, and ignores patch text", () => {
    const input = { patchText: "*** Update File: unrelated.cs" }
    const result = {
      metadata: {
        files: [
          { file: "src/App/Example.cs", status: "modified" },
          { file: "src/App/New.cs", status: "added" },
          { file: "src/App/Gone.cs", status: "deleted" },
        ],
      },
    }

    expect(changedPaths("patch", input, result)).toEqual([
      "src/App/Example.cs",
      "src/App/New.cs",
    ])
    expect(changedPaths("patch", input, {})).toEqual([])
  })

  test("recognizes write and edit paths but trusts an explicit empty file list", () => {
    const filePath = "src/App/Example.cs"
    expect(changedPaths("write", { filePath }, {})).toEqual([filePath])
    expect(changedPaths("edit", { path: filePath }, {})).toEqual([filePath])
    expect(changedPaths("write", { filePath }, { metadata: { files: [] } })).toEqual([])
  })

  test("ignores shell and Rider tools, preventing recursive formatting", () => {
    const result = { metadata: { files: [{ file: "src/App/Example.cs" }] } }
    for (const tool of ["shell", "rider_reformat_file", "rider_lint_files"]) {
      expect(changedPaths(tool, { path: "src/App/Example.cs" }, result)).toEqual([])
    }
  })

  test("converts repository, nested-directory, and absolute paths to solution paths", async () => {
    const solutionRoot = join(repositoryRoot, "src")
    const absolutePath = join(repositoryRoot, "src/App/Example.cs")
    const files = await solutionFiles(
      ["src/App/Example.cs", absolutePath],
      repositoryRoot,
      solutionRoot,
    )
    const nestedFiles = await solutionFiles(
      ["Example.cs"],
      join(solutionRoot, "App"),
      solutionRoot,
    )

    expect(files).toEqual(["App/Example.cs"])
    expect(nestedFiles).toEqual(["App/Example.cs"])
  })

  test("excludes generated files, unsupported files, missing files, and paths outside src", async () => {
    const generatedFiles = [
      "src/App/obj/Output.cs",
      "src/App/bin/Output.cs",
      "src/App/Output.g.cs",
      "src/App/Output.g.i.cs",
      "src/App/Output.generated.cs",
    ]
    for (const path of generatedFiles) {
      await createFile(path)
    }

    const files = await solutionFiles([
      "src/App/Example.cs",
      ...generatedFiles,
      "src/App/appsettings.json",
      "src/App/Missing.cs",
      "../other.cs",
      "outside.cs",
    ], repositoryRoot, join(repositoryRoot, "src"))

    expect(files).toEqual(["App/Example.cs"])
  })

  test("rejects symlinks that lead outside the solution", async () => {
    await createFile("outside.cs")
    await symlink(
      join(repositoryRoot, "outside.cs"),
      join(repositoryRoot, "src/App/Link.cs"),
    )

    const files = await solutionFiles(
      ["src/App/Link.cs"], repositoryRoot, join(repositoryRoot, "src"),
    )
    expect(files).toEqual([])
  })

  test("rejects symlinks into generated output and non-C# files", async () => {
    await createFile("src/App/obj/Output.cs")
    await createFile("src/App/settings.json", "{}")
    await symlink(
      join(repositoryRoot, "src/App/obj/Output.cs"),
      join(repositoryRoot, "src/App/GeneratedLink.cs"),
    )
    await symlink(
      join(repositoryRoot, "src/App/settings.json"),
      join(repositoryRoot, "src/App/JsonLink.cs"),
    )

    const files = await solutionFiles(
      ["src/App/GeneratedLink.cs", "src/App/JsonLink.cs"],
      repositoryRoot,
      join(repositoryRoot, "src"),
    )
    expect(files).toEqual([])
  })
})

describe("reporting and cancellation", () => {
  test("appends findings without replacing the edit output or metadata", () => {
    const originalResult = {
      content: "Edit succeeded",
      output: { saved: true },
      metadata: { files: ["original"] },
    }
    const result = appendReport(originalResult, {
      step: "diagnostics",
      text: "warning",
      files: ["App/Example.cs"],
      status: "checked",
    })

    expect(result.content).toEqual([
      { type: "text", text: "Edit succeeded" },
      { type: "text", text: "Rider post-edit diagnostics\nwarning" },
    ])
    expect(result.output).toEqual({ saved: true })
    expect(result.metadata?.files).toEqual(["original"])
  })

  test("bounds slow calls and aborts their signal", async () => {
    let operationSignal: AbortSignal | undefined
    const operation = async (signal: AbortSignal) => {
      operationSignal = signal
      return await new Promise<never>(() => {})
    }

    await expect(
      withDeadline(operation, new AbortController().signal, 5),
    ).rejects.toThrow("timed out")
    expect(operationSignal?.aborted).toBe(true)
  })

  test("does not start work after plugin cleanup", async () => {
    const lifetime = new AbortController()
    lifetime.abort(new Error("Plugin unloaded"))
    let started = false
    const operation = async () => { started = true }

    await expect(withDeadline(operation, lifetime.signal, 1000))
      .rejects.toThrow("Plugin unloaded")
    expect(started).toBe(false)
  })

  test("cancels an in-flight operation when the plugin unloads", async () => {
    const lifetime = new AbortController()
    const started = Promise.withResolvers<AbortSignal>()
    const operation = async (signal: AbortSignal) => {
      started.resolve(signal)
      return await new Promise<never>(() => {})
    }

    const result = withDeadline(operation, lifetime.signal, 1000)
    const operationSignal = await started.promise
    lifetime.abort(new Error("Plugin unloaded"))

    await expect(result).rejects.toThrow("Plugin unloaded")
    expect(operationSignal.aborted).toBe(true)
  })
})

describe("post-edit hook", () => {
  test("leaves the edit unchanged without resolving its session when both Rider tools are unavailable", async () => {
    const fixture = createFixture(repositoryRoot, {
      formatter: "unavailable",
      diagnostics: "unavailable",
      workingDirectory: join(repositoryRoot, "missing"),
    })
    const originalResult = fixture.event.result
    await fixture.run()

    expect(fixture.event.result).toBe(originalResult)
    expect(fixture.lookupCounts).toEqual({ tools: 1, sessions: 0 })
    expect(fixture.permissionActions).toEqual([])
    expect(fixture.formatRequests).toEqual([])
    expect(fixture.diagnosticRequests).toEqual([])
  })

  test("refreshes Rider tool availability for each edit without re-registering", async () => {
    const fixture = createFixture(repositoryRoot, {
      formatter: "unavailable",
      diagnostics: "unavailable",
    })
    const originalResult = fixture.event.result
    const hook = await fixture.start()
    try {
      await hook.run()
      expect(fixture.event.result).toBe(originalResult)

      fixture.setToolStates("available", "available")
      await hook.run()
      expect(fixture.formatRequests).toHaveLength(1)
      expect(fixture.diagnosticRequests).toHaveLength(1)

      const checkedResult = fixture.event.result
      fixture.setToolStates("unavailable", "unavailable")
      await hook.run()
      expect(fixture.event.result).toBe(checkedResult)
      expect(fixture.lookupCounts).toEqual({ tools: 3, sessions: 1 })
      expect(fixture.formatRequests).toHaveLength(1)
      expect(fixture.diagnosticRequests).toHaveLength(1)
    } finally {
      hook.cleanup()
    }
  })

  test("waits for formatting before diagnostics and preserves partial-result flags", async () => {
    const fixture = createFixture(repositoryRoot)
    await fixture.run()

    expect(fixture.formatRequests).toEqual([{ files: ["App/Example.cs"] }])
    expect(fixture.diagnosticRequests).toEqual([{
      files: ["App/Example.cs"],
      min_severity: "warning",
      timeout: 10_000,
    }])
    expect(fixture.executionOrder).toEqual([
      "formatting started", "formatting completed", "diagnostics",
    ])
    expect(fixture.permissionActions).toEqual(["rider_reformat_file", "rider_lint_files"])
    expect(fixture.event.result.metadata).toMatchObject({
      riderPostEdit: {
        status: "checked",
        formatting: { status: "formatted" },
        diagnostics: { status: "checked" },
      },
    })
    expect(getReportText(fixture.event.result, "diagnostics")).toContain('"more":true')
  })

  test("includes the formatter diff without replacing the edit or diagnostic output", async () => {
    const diff = "--- App/Example.cs\n+++ App/Example.cs\n-class Example {}\n+class Example\n+{}"
    const fixture = createFixture(repositoryRoot, { formatterOutput: diff })
    await fixture.run()

    const result = fixture.event.result
    expect(result.content?.[0]).toEqual({ type: "text", text: "Edit succeeded" })
    expect(getReportText(result, "formatting")).toBe(`Rider post-edit formatting\n${diff}`)
    expect(getReportText(result, "diagnostics")).toContain("Rider post-edit diagnostics")
    expect(result.metadata?.files).toEqual([{ file: "src/App/Example.cs", status: "modified" }])
  })

  for (const state of ["unavailable", "denied", "failed"] as const) {
    test(`still runs diagnostics when formatting is ${state}`, async () => {
      const fixture = createFixture(repositoryRoot, { formatter: state })
      await fixture.run()

      expect(fixture.event.status).toBe("completed")
      expect(fixture.event.result.content?.[0]).toEqual({ type: "text", text: "Edit succeeded" })
      expect(getReportText(fixture.event.result, "formatting")).toContain("Formatting did not complete")
      expect(fixture.event.result.metadata).toMatchObject({
        riderPostEdit: {
          formatting: { status: "unavailable" },
          diagnostics: { status: "checked" },
        },
      })
      expect(fixture.diagnosticRequests).toHaveLength(1)
      if (state !== "failed") {
        expect(fixture.formatRequests).toHaveLength(0)
      }
    })
  }

  test("caps the number of files and reports omitted files", async () => {
    const fixture = createFixture(repositoryRoot)
    const paths: string[] = []
    for (let index = 0; index < 21; index++) {
      const path = `src/App/Example${index}.cs`
      await createFile(path)
      paths.push(path)
    }
    fixture.setEditedFiles(paths)
    await fixture.run()

    expect(fixture.formatRequests[0].files).toHaveLength(20)
    expect(fixture.diagnosticRequests[0].files).toHaveLength(20)
    expect(getReportText(fixture.event.result, "formatting"))
      .toContain("1 additional file was not formatted")
    expect(getReportText(fixture.event.result, "diagnostics"))
      .toContain("1 additional file was not checked")
  })

  test("reports truncated diagnostics", async () => {
    const fixture = createFixture(repositoryRoot, { diagnosticOutput: "x".repeat(20_000) })
    await fixture.run()

    const report = getReportText(fixture.event.result, "diagnostics")
    expect(report).toContain("Diagnostics truncated")
    expect(report.length).toBeLessThan(13_000)
  })

  test("reports truncated formatting output", async () => {
    const fixture = createFixture(repositoryRoot, { formatterOutput: "x".repeat(20_000) })
    await fixture.run()

    const report = getReportText(fixture.event.result, "formatting")
    expect(report).toContain("Formatting output truncated. Run rider_reformat_file")
    expect(report.length).toBeLessThan(13_000)
  })

  for (const state of ["unavailable", "denied", "failed"] as const) {
    test(`keeps the edit and formatter result when diagnostics are ${state}`, async () => {
      const fixture = createFixture(repositoryRoot, { diagnostics: state })
      await fixture.run()

      expect(fixture.event.status).toBe("completed")
      expect(fixture.event.result.content?.[0]).toEqual({ type: "text", text: "Edit succeeded" })
      expect(fixture.event.result.metadata).toMatchObject({
        riderPostEdit: {
          status: "unavailable",
          formatting: { status: "formatted" },
          diagnostics: { status: "unavailable" },
        },
      })
      expect(fixture.formatRequests).toHaveLength(1)
      if (state === "denied") {
        expect(fixture.diagnosticRequests).toHaveLength(0)
      }
    })
  }

  test("runs neither tool when both permissions are denied", async () => {
    const fixture = createFixture(repositoryRoot, { formatter: "denied", diagnostics: "denied" })
    await fixture.run()

    expect(fixture.formatRequests).toHaveLength(0)
    expect(fixture.diagnosticRequests).toHaveLength(0)
    expect(fixture.event.status).toBe("completed")
  })

  test("ignores failed edits, unrelated tools, and unsupported files", async () => {
    const failedEdit = createFixture(repositoryRoot)
    failedEdit.event.status = "error"

    const formatterCall = createFixture(repositoryRoot)
    formatterCall.event.tool = "rider_reformat_file"

    const diagnosticsCall = createFixture(repositoryRoot)
    diagnosticsCall.event.tool = "rider_lint_files"

    const unsupportedFile = createFixture(repositoryRoot)
    unsupportedFile.setEditedFiles(["src/appsettings.json"])

    for (const fixture of [failedEdit, formatterCall, diagnosticsCall, unsupportedFile]) {
      await fixture.run()
      expect(fixture.lookupCounts).toEqual({ tools: 0, sessions: 0 })
      expect(fixture.formatRequests).toHaveLength(0)
      expect(fixture.diagnosticRequests).toHaveLength(0)
    }
  })

  test("ignores edits from another checkout", async () => {
    const otherDirectory = await realpath(join(repositoryRoot, ".."))
    const fixture = createFixture(repositoryRoot, { workingDirectory: otherDirectory })
    fixture.setEditedFiles([join(repositoryRoot, "src/App/Example.cs")])
    await fixture.run()

    expect(fixture.formatRequests).toHaveLength(0)
    expect(fixture.diagnosticRequests).toHaveLength(0)
  })
})

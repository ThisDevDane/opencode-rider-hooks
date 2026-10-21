import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { pathToFileURL } from "node:url"
import { changedPaths, sourceFiles } from "../files.ts"
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

    assert.deepEqual(changedPaths("patch", input, result), [
      "src/App/Example.cs",
      "src/App/New.cs",
    ])
    assert.deepEqual(changedPaths("patch", input, {}), [])
  })

  test("recognizes write and edit paths but trusts an explicit empty file list", () => {
    const filePath = "src/App/Example.cs"
    assert.deepEqual(changedPaths("write", { filePath }, {}), [filePath])
    assert.deepEqual(changedPaths("edit", { path: filePath }, {}), [filePath])
    assert.deepEqual(changedPaths("write", { filePath }, { metadata: { files: [] } }), [])
  })

  test("ignores shell and Rider tools, preventing recursive formatting", () => {
    const result = { metadata: { files: [{ file: "src/App/Example.cs" }] } }
    for (const tool of ["shell", "rider_reformat_file", "rider_lint_files"]) {
      assert.deepEqual(changedPaths(tool, { path: "src/App/Example.cs" }, result), [])
    }
  })

  test("canonicalizes repository, nested-directory, and absolute paths", async () => {
    const solutionRoot = join(repositoryRoot, "src")
    const absolutePath = join(repositoryRoot, "src/App/Example.cs")
    const files = await sourceFiles(
      ["src/App/Example.cs", absolutePath],
      repositoryRoot,
      solutionRoot,
    )
    const nestedFiles = await sourceFiles(
      ["Example.cs"],
      join(solutionRoot, "App"),
      solutionRoot,
    )

    assert.deepEqual(files, [absolutePath])
    assert.deepEqual(nestedFiles, [absolutePath])
  })

  test("excludes generated files, unsupported files, missing files, and paths outside the selected root", async () => {
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

    const files = await sourceFiles([
      "src/App/Example.cs",
      ...generatedFiles,
      "src/App/appsettings.json",
      "src/App/Missing.cs",
      "../other.cs",
      "outside.cs",
    ], repositoryRoot, join(repositoryRoot, "src"))

    assert.deepEqual(files, [join(repositoryRoot, "src/App/Example.cs")])
  })

  test("rejects symlinks that lead outside the solution", async () => {
    await createFile("outside.cs")
    await symlink(
      join(repositoryRoot, "outside.cs"),
      join(repositoryRoot, "src/App/Link.cs"),
    )

    const files = await sourceFiles(
      ["src/App/Link.cs"], repositoryRoot, join(repositoryRoot, "src"),
    )
    assert.deepEqual(files, [])
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

    const files = await sourceFiles(
      ["src/App/GeneratedLink.cs", "src/App/JsonLink.cs"],
      repositoryRoot,
      join(repositoryRoot, "src"),
    )
    assert.deepEqual(files, [])
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

    assert.deepEqual(result.content, [
      { type: "text", text: "Edit succeeded" },
      { type: "text", text: "Rider post-edit diagnostics\nwarning" },
    ])
    assert.deepEqual(result.output, { saved: true })
    assert.deepEqual(result.metadata?.files, ["original"])
  })

  test("bounds slow calls and aborts their signal", async () => {
    let operationSignal: AbortSignal | undefined
    const operation = async (signal: AbortSignal) => {
      operationSignal = signal
      return await new Promise<never>(() => {})
    }

    await assert.rejects(
      withDeadline(operation, new AbortController().signal, 5),
      /timed out/,
    )
    assert.equal(operationSignal?.aborted, true)
  })

  test("does not start work after plugin cleanup", async () => {
    const lifetime = new AbortController()
    lifetime.abort(new Error("Plugin unloaded"))
    let started = false
    const operation = async () => { started = true }

    await assert.rejects(withDeadline(operation, lifetime.signal, 1000), /Plugin unloaded/)
    assert.equal(started, false)
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

    await assert.rejects(result, /Plugin unloaded/)
    assert.equal(operationSignal.aborted, true)
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

    assert.equal(fixture.event.result, originalResult)
    assert.deepEqual(fixture.lookupCounts, { tools: 1, sessions: 0 })
    assert.deepEqual(fixture.permissionActions, [])
    assert.deepEqual(fixture.formatRequests, [])
    assert.deepEqual(fixture.diagnosticRequests, [])
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
      assert.equal(fixture.event.result, originalResult)

      fixture.setToolStates("available", "available")
      await hook.run()
      assert.equal(fixture.formatRequests.length, 1)
      assert.equal(fixture.diagnosticRequests.length, 1)

      const checkedResult = fixture.event.result
      fixture.setToolStates("unavailable", "unavailable")
      await hook.run()
      assert.equal(fixture.event.result, checkedResult)
      assert.deepEqual(fixture.lookupCounts, { tools: 3, sessions: 1 })
      assert.equal(fixture.formatRequests.length, 1)
      assert.equal(fixture.diagnosticRequests.length, 1)
    } finally {
      hook.cleanup()
    }
  })

  test("does not require src, a solution, or a project file", async () => {
    await rm(join(repositoryRoot, "src"), { recursive: true })
    await createFile("Program.cs", "class Program {}")
    const file = join(repositoryRoot, "Program.cs")
    const fixture = createFixture(repositoryRoot)
    fixture.setEditedFiles(["Program.cs"])
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [{ files: [file], projectPath: file }])
    assert.partialDeepStrictEqual(fixture.diagnosticRequests[0], { files: [file], projectPath: file })
  })

  test("routes relative edits from nested sessions using canonical file paths", async () => {
    const file = join(repositoryRoot, "src/App/Example.cs")
    const fixture = createFixture(repositoryRoot, {
      workingDirectory: join(repositoryRoot, "src/App"),
    })
    fixture.setEditedFiles(["Example.cs", file])
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [{ files: [file], projectPath: file }])
    assert.equal(fixture.diagnosticRequests.length, 1)
  })

  test("rejects file symlinks that escape the checkout during unscoped routing", async () => {
    const otherRoot = await mkdtemp(join(dirname(repositoryRoot), "rider-other-"))
    try {
      const outside = join(otherRoot, "Example.cs")
      await writeFile(outside, "class Example {}")
      await symlink(outside, join(repositoryRoot, "src/App/Link.cs"))
      const fixture = createFixture(repositoryRoot)
      fixture.setEditedFiles(["src/App/Link.cs", outside])
      await fixture.run()

      assert.equal(fixture.formatRequests.length, 0)
      assert.equal(fixture.diagnosticRequests.length, 0)
    } finally {
      await rm(otherRoot, { recursive: true, force: true })
    }
  })

  test("uses the configured HTTP selector without overriding it", async () => {
    await createFile("backend/Example.cs")
    const root = join(repositoryRoot, "backend")
    const file = join(root, "Example.cs")
    const fixture = createFixture(repositoryRoot, {
      mcpServer: {
        type: "remote",
        url: "http://localhost:64342/stream",
        headers: { IJ_MCP_SERVER_PROJECT_PATH: root },
      },
    })
    fixture.setEditedFiles(["backend/Example.cs", "src/App/Example.cs"])
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [{ files: [file] }])
    assert.deepEqual(fixture.diagnosticRequests, [{
      files: [file], min_severity: "warning", timeout: 10_000,
    }])
  })

  test("batches files on a scoped stdio connection", async () => {
    await createFile("src/App/Second.cs")
    const root = join(repositoryRoot, "src")
    const files = [join(root, "App/Example.cs"), join(root, "App/Second.cs")]
    const fixture = createFixture(repositoryRoot, {
      mcpServer: {
        type: "local",
        command: ["rider", "stdioMcpServer"],
        environment: { IJ_MCP_SERVER_PROJECT_PATH: root },
      },
    })
    fixture.setEditedFiles(files)
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [{ files }])
    assert.equal(fixture.diagnosticRequests.length, 1)
  })

  test("supports file-URI selectors and canonicalizes symlinked directories", async () => {
    await symlink(join(repositoryRoot, "src"), join(repositoryRoot, "backend"))
    const file = join(repositoryRoot, "src/App/Example.cs")
    const fixture = createFixture(repositoryRoot, {
      mcpServer: {
        type: "remote",
        url: "http://localhost:64342/stream",
        headers: {
          IJ_MCP_SERVER_PROJECT_PATH: pathToFileURL(join(repositoryRoot, "backend")).href,
        },
      },
    })
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [{ files: [file] }])
  })

  test("accepts a selector pointing at a solution file", async () => {
    await createFile("src/App.slnx")
    const fixture = createFixture(repositoryRoot, {
      mcpServer: {
        type: "remote",
        url: "http://localhost:64342/stream",
        headers: { IJ_MCP_SERVER_PROJECT_PATH: join(repositoryRoot, "src/App.slnx") },
      },
    })
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [{
      files: [join(repositoryRoot, "src/App/Example.cs")],
    }])
  })

  test("routes monorepo edits through Rider regardless of solution format", async () => {
    const paths = [
      "apps/store/Program.cs",
      "services/payments/Program.cs",
      "tools/importer/Program.cs",
    ]
    for (const path of [
      "apps/store/Store.slnx", "services/payments/Payments.sln", "tools/importer/Importer.csproj",
      ...paths,
    ]) {
      await createFile(path)
    }
    const fixture = createFixture(repositoryRoot)
    fixture.setEditedFiles(paths)
    await fixture.run()

    const requests = paths.map(path => {
      const file = join(repositoryRoot, path)
      return { files: [file], projectPath: file }
    })
    assert.deepEqual(fixture.formatRequests, requests)
    assert.deepEqual(fixture.diagnosticRequests, requests.map(request => ({
      ...request, min_severity: "warning", timeout: 10_000,
    })))
    assert.deepEqual(fixture.executionOrder, [
      "formatting started", "formatting completed",
      "formatting started", "formatting completed",
      "formatting started", "formatting completed",
      "diagnostics", "diagnostics", "diagnostics",
    ])
    assert.deepEqual(fixture.permissionActions, ["rider_reformat_file", "rider_lint_files"])
  })

  test("preserves project-selection errors and continues with other files", async () => {
    await createFile("other/Example.cs")
    const file = join(repositoryRoot, "src/App/Example.cs")
    const error = "Unable to determine the target project for the current MCP tool call."
    const fixture = createFixture(repositoryRoot, { projectErrors: { [file]: error } })
    fixture.setEditedFiles([file, "other/Example.cs"])
    await fixture.run()

    assert.equal(fixture.formatRequests.length, 2)
    assert.equal(fixture.diagnosticRequests.length, 2)
    assert.ok(getReportText(fixture.event.result, "formatting").includes(error))
    assert.ok(getReportText(fixture.event.result, "diagnostics").includes(error))
    assert.partialDeepStrictEqual(fixture.event.result.metadata, {
      riderPostEdit: {
        formatting: { status: "unavailable" },
        diagnostics: { status: "unavailable" },
      },
    })
    assert.deepEqual(fixture.event.result.content?.[0], { type: "text", text: "Edit succeeded" })
  })

  test("does not fall back when a configured selector is invalid", async () => {
    const selectors = [
      ".", join(repositoryRoot, "missing"), dirname(repositoryRoot),
    ]
    await symlink(dirname(repositoryRoot), join(repositoryRoot, "outside"))
    selectors.push(join(repositoryRoot, "outside"))

    for (const selector of selectors) {
      const fixture = createFixture(repositoryRoot, {
        mcpServer: {
          type: "remote",
          url: "http://localhost:64342/stream",
          headers: { IJ_MCP_SERVER_PROJECT_PATH: selector },
        },
      })
      await fixture.run()

      assert.equal(fixture.formatRequests.length, 0)
      assert.equal(fixture.diagnosticRequests.length, 0)
      assert.ok(getReportText(fixture.event.result, "diagnostics").includes("Check skipped"))
      assert.deepEqual(fixture.event.result.content?.[0], { type: "text", text: "Edit succeeded" })
    }
  })

  test("keeps generated-directory exclusions even when the configured selector is inside one", async () => {
    await createFile("src/App/obj/Output.cs")
    const fixture = createFixture(repositoryRoot, {
      mcpServer: {
        type: "remote",
        url: "http://localhost:64342/stream",
        headers: { IJ_MCP_SERVER_PROJECT_PATH: join(repositoryRoot, "src/App/obj") },
      },
    })
    fixture.setEditedFiles(["src/App/obj/Output.cs"])
    await fixture.run()

    assert.equal(fixture.formatRequests.length, 0)
    assert.equal(fixture.diagnosticRequests.length, 0)
  })

  test("waits for formatting before diagnostics and preserves partial-result flags", async () => {
    const fixture = createFixture(repositoryRoot)
    await fixture.run()

    const file = join(repositoryRoot, "src/App/Example.cs")
    assert.deepEqual(fixture.formatRequests, [{ files: [file], projectPath: file }])
    assert.deepEqual(fixture.diagnosticRequests, [{
      files: [file],
      projectPath: file,
      min_severity: "warning",
      timeout: 10_000,
    }])
    assert.deepEqual(fixture.executionOrder, [
      "formatting started", "formatting completed", "diagnostics",
    ])
    assert.deepEqual(fixture.permissionActions, ["rider_reformat_file", "rider_lint_files"])
    assert.partialDeepStrictEqual(fixture.event.result.metadata, {
      riderPostEdit: {
        status: "checked",
        formatting: { status: "formatted" },
        diagnostics: { status: "checked" },
      },
    })
    assert.ok(getReportText(fixture.event.result, "diagnostics").includes('"more":true'))
  })

  test("includes the formatter diff without replacing the edit or diagnostic output", async () => {
    const diff = "--- App/Example.cs\n+++ App/Example.cs\n-class Example {}\n+class Example\n+{}"
    const fixture = createFixture(repositoryRoot, { formatterOutput: diff })
    await fixture.run()

    const result = fixture.event.result
    assert.deepEqual(result.content?.[0], { type: "text", text: "Edit succeeded" })
    assert.equal(getReportText(result, "formatting"), `Rider post-edit formatting\n${diff}`)
    assert.ok(getReportText(result, "diagnostics").includes("Rider post-edit diagnostics"))
    assert.deepEqual(result.metadata?.files, [{ file: "src/App/Example.cs", status: "modified" }])
  })

  test("retries solution-model rejection of a newly added file before diagnostics", async () => {
    await createFile("src/App/New.cs", "class New {}")
    const fixture = createFixture(repositoryRoot, {
      formatterErrors: ["Requested files are not part of the current solution."],
      formatterOutput: "formatter diff",
    })
    const file = join(repositoryRoot, "src/App/New.cs")
    fixture.event.result = {
      ...fixture.event.result,
      metadata: { files: [{ file, status: "added" }] },
    }
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [
      { files: [file], projectPath: file },
      { files: [file], projectPath: file },
    ])
    assert.deepEqual(fixture.executionOrder, [
      "formatting started", "formatting started", "formatting completed", "diagnostics",
    ])
    assert.deepEqual(fixture.permissionActions, ["rider_reformat_file", "rider_lint_files"])
    assert.deepEqual(fixture.event.result.content?.[0], { type: "text", text: "Edit succeeded" })
    assert.ok(getReportText(fixture.event.result, "formatting").includes("succeeded after 1 retry"))
    assert.ok(getReportText(fixture.event.result, "formatting").includes("formatter diff"))
    assert.partialDeepStrictEqual(fixture.event.result.metadata, {
      files: [{ file, status: "added" }],
      riderPostEdit: {
        formatting: { status: "formatted" },
        diagnostics: { status: "checked" },
      },
    })
  })

  for (const state of ["unavailable", "denied", "failed"] as const) {
    test(`still runs diagnostics when formatting is ${state}`, async () => {
      const fixture = createFixture(repositoryRoot, { formatter: state })
      await fixture.run()

      assert.equal(fixture.event.status, "completed")
      assert.deepEqual(fixture.event.result.content?.[0], { type: "text", text: "Edit succeeded" })
      assert.ok(getReportText(fixture.event.result, "formatting").includes("Formatting did not complete"))
      assert.partialDeepStrictEqual(fixture.event.result.metadata, {
        riderPostEdit: {
          formatting: { status: "unavailable" },
          diagnostics: { status: "checked" },
        },
      })
      assert.equal(fixture.diagnosticRequests.length, 1)
      if (state !== "failed") {
        assert.equal(fixture.formatRequests.length, 0)
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

    assert.equal(fixture.formatRequests.flatMap(request => request.files).length, 20)
    assert.equal(fixture.diagnosticRequests.flatMap(request => request.files).length, 20)
    assert.ok(getReportText(fixture.event.result, "formatting")
      .includes("1 additional file was not formatted"))
    assert.ok(getReportText(fixture.event.result, "diagnostics")
      .includes("1 additional file was not checked"))
  })

  test("reports truncated diagnostics", async () => {
    const fixture = createFixture(repositoryRoot, { diagnosticOutput: "x".repeat(20_000) })
    await fixture.run()

    const report = getReportText(fixture.event.result, "diagnostics")
    assert.ok(report.includes("Diagnostics truncated"))
    assert.ok(report.length < 13_000)
  })

  test("reports truncated formatting output", async () => {
    const fixture = createFixture(repositoryRoot, { formatterOutput: "x".repeat(20_000) })
    await fixture.run()

    const report = getReportText(fixture.event.result, "formatting")
    assert.ok(report.includes("Formatting output truncated. Run rider_reformat_file"))
    assert.ok(report.length < 13_000)
  })

  test("bounds combined output across unscoped file requests", async () => {
    await createFile("src/App/Second.cs")
    const fixture = createFixture(repositoryRoot, {
      formatterOutput: "x".repeat(8000), diagnosticOutput: "y".repeat(8000),
    })
    fixture.setEditedFiles(["src/App/Example.cs", "src/App/Second.cs"])
    await fixture.run()

    for (const step of ["formatting", "diagnostics"] as const) {
      const report = getReportText(fixture.event.result, step)
      assert.ok(report.includes("truncated"))
      assert.ok(report.length < 13_000)
    }
  })

  for (const state of ["unavailable", "denied", "failed"] as const) {
    test(`keeps the edit and formatter result when diagnostics are ${state}`, async () => {
      const fixture = createFixture(repositoryRoot, { diagnostics: state })
      await fixture.run()

      assert.equal(fixture.event.status, "completed")
      assert.deepEqual(fixture.event.result.content?.[0], { type: "text", text: "Edit succeeded" })
      assert.partialDeepStrictEqual(fixture.event.result.metadata, {
        riderPostEdit: {
          status: "unavailable",
          formatting: { status: "formatted" },
          diagnostics: { status: "unavailable" },
        },
      })
      assert.equal(fixture.formatRequests.length, 1)
      if (state === "denied") {
        assert.equal(fixture.diagnosticRequests.length, 0)
      }
    })
  }

  test("runs neither tool when both permissions are denied", async () => {
    const fixture = createFixture(repositoryRoot, { formatter: "denied", diagnostics: "denied" })
    await fixture.run()

    assert.equal(fixture.formatRequests.length, 0)
    assert.equal(fixture.diagnosticRequests.length, 0)
    assert.equal(fixture.event.status, "completed")
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
      assert.deepEqual(fixture.lookupCounts, { tools: 0, sessions: 0 })
      assert.equal(fixture.formatRequests.length, 0)
      assert.equal(fixture.diagnosticRequests.length, 0)
    }
  })

  test("ignores edits from another checkout", async () => {
    const otherDirectory = await realpath(join(repositoryRoot, ".."))
    const fixture = createFixture(repositoryRoot, { workingDirectory: otherDirectory })
    fixture.setEditedFiles([join(repositoryRoot, "src/App/Example.cs")])
    await fixture.run()

    assert.equal(fixture.formatRequests.length, 0)
    assert.equal(fixture.diagnosticRequests.length, 0)
  })
})

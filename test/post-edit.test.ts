import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
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

    assert.deepEqual(files, ["App/Example.cs"])
    assert.deepEqual(nestedFiles, ["App/Example.cs"])
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

    assert.deepEqual(files, ["App/Example.cs"])
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

    const files = await solutionFiles(
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
  test("waits for formatting before diagnostics and preserves partial-result flags", async () => {
    const fixture = createFixture(repositoryRoot)
    await fixture.run()

    assert.deepEqual(fixture.formatRequests, [{ files: ["App/Example.cs"] }])
    assert.deepEqual(fixture.diagnosticRequests, [{
      files: ["App/Example.cs"],
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

    assert.equal(fixture.formatRequests[0].files.length, 20)
    assert.equal(fixture.diagnosticRequests[0].files.length, 20)
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

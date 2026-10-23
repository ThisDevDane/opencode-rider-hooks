import assert from "node:assert/strict"
import { type ChildProcess, type spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { setTimeout } from "node:timers/promises"
import type { Mcp } from "@opencode/plugin"
import { launchRider, riderCommand, worktreeConflict, worktreeOptions, worktreeTarget } from "../worktrees.ts"

let root: string
const enabled = worktreeOptions({ openWorktrees: true })
const server: Mcp.ServerConfig = { type: "remote", url: "http://localhost:64342/stream" }

beforeEach(async () => {
  const temporaryRoot = join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  root = await realpath(await mkdtemp(join(temporaryRoot, "rider-worktrees-")))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("worktree options", () => {
  test("requires explicit opt-in", () => {
    assert.deepEqual(worktreeOptions({}), { openWorktrees: false, worktreeProject: ".", riderCommand: undefined })
    assert.equal(enabled.openWorktrees, true)
    assert.equal(worktreeOptions({ openWorktrees: false }).openWorktrees, false)
  })

  test("rejects malformed options", () => {
    for (const options of [
      { openWorktrees: "true" }, { openWorktrees: 1 }, { openWorktrees: null },
      { worktreeProject: "" }, { worktreeProject: 1 },
      { riderCommand: "rider" }, { riderCommand: [] }, { riderCommand: [""] }, { riderCommand: [1] },
    ]) {
      assert.throws(() => worktreeOptions(options), /must be/)
    }
  })

  test("auto-open and HTTP selectors are mutually exclusive, including case-insensitive headers", () => {
    for (const name of ["IJ_MCP_SERVER_PROJECT_PATH", "ij_mcp_server_project_path"]) {
      const scoped: Mcp.ServerConfig = { ...server, headers: { [name]: root } }
      assert.match(worktreeConflict(enabled, scoped)!, /mutually exclusive/)
      assert.equal(worktreeConflict(worktreeOptions({}), scoped), undefined)
    }
    assert.equal(worktreeConflict(enabled, server), undefined)
    assert.equal(worktreeConflict(enabled, undefined), undefined)
  })

  test("also rejects an effective stdio project selector", () => {
    const scoped: Mcp.ServerConfig = {
      type: "local", command: ["rider"], environment: { IJ_MCP_SERVER_PROJECT_PATH: root },
    }
    assert.match(worktreeConflict(enabled, scoped)!, /IJ_MCP_SERVER_PROJECT_PATH/)
  })
})

describe("worktree launch target", () => {
  test("defaults to the checkout root", async () => {
    assert.equal(await worktreeTarget(root, "."), root)
  })

  test("resolves directories and solution or project paths inside the worktree", async () => {
    await mkdir(join(root, "backend"))
    assert.equal(await worktreeTarget(root, "backend"), join(root, "backend"))
    for (const extension of ["sln", "slnx", "csproj", "fsproj", "vbproj"]) {
      const name = `backend/App.${extension}`
      await writeFile(join(root, name), "")
      assert.equal(await worktreeTarget(root, name), join(root, name))
    }
  })

  test("rejects absolute paths, traversal, symlink escapes, missing files, and non-project files", async () => {
    await symlink(dirname(root), join(root, "escape"), "junction")
    await writeFile(join(root, "Example.cs"), "")
    for (const project of [root, "..", "../other", "escape", "missing.sln", "Example.cs"]) {
      await assert.rejects(worktreeTarget(root, project))
    }
  })
})

describe("Rider launchers", () => {
  function fakeSpawn(event: "spawn" | "error" | "exit" = "spawn", code = 0) {
    const calls: unknown[][] = []
    let unreferenced = false
    const child = new EventEmitter() as ChildProcess
    child.unref = () => { unreferenced = true }
    const spawnProcess = ((...args: unknown[]) => {
      calls.push(args)
      queueMicrotask(() => {
        if (event === "error") child.emit("error", new Error("ENOENT"))
        else if (event === "exit") child.emit("exit", code)
        else child.emit("spawn")
      })
      return child
    }) as typeof spawn
    return { calls, spawnProcess, unreferenced: () => unreferenced }
  }

  test("uses the macOS app launcher and Windows executable", () => {
    assert.deepEqual(riderCommand(enabled, "darwin"), ["/usr/bin/open", "-a", "Rider"])
    assert.deepEqual(riderCommand(enabled, "win32"), ["rider64.exe"])
    assert.throws(() => riderCommand(enabled, "linux"), /requires macOS or Windows/)
  })

  for (const platform of ["darwin", "win32"] as const) {
    test(`launches on ${platform} without shell interpolation or waiting for Rider to close`, async () => {
      const target = platform === "win32" ? 'C:\\work trees\\feature & "test"\\App.slnx' : '/work trees/feature;$(touch nope)/App.slnx'
      const fake = fakeSpawn(platform === "darwin" ? "exit" : "spawn")
      await launchRider(target, enabled, new AbortController().signal, platform, fake.spawnProcess)
      const [command, ...args] = riderCommand(enabled, platform)
      assert.deepEqual(fake.calls, [[command, [...args, target], {
        detached: true, stdio: "ignore", windowsHide: true, shell: false,
      }]])
      assert.equal(fake.unreferenced(), true)
    })
  }

  test("supports an explicit executable path or macOS app name without splitting spaces", async () => {
    const options = worktreeOptions({ openWorktrees: true, riderCommand: ["C:\\Program Files\\JetBrains\\Rider\\bin\\rider64.exe"] })
    const fake = fakeSpawn()
    await launchRider(root, options, new AbortController().signal, "win32", fake.spawnProcess)
    assert.equal(fake.calls[0][0], options.riderCommand![0])
    assert.deepEqual(fake.calls[0][1], [root])
  })

  test("reports a missing executable and failed macOS app launch", async () => {
    const missing = fakeSpawn("error")
    await assert.rejects(launchRider(root, enabled, new AbortController().signal, "win32", missing.spawnProcess), /ENOENT/)
    const failed = fakeSpawn("exit", 1)
    await assert.rejects(launchRider(root, enabled, new AbortController().signal, "darwin", failed.spawnProcess), /exited with code 1/)
  })

  test("does not launch after cleanup", async () => {
    const lifetime = new AbortController()
    lifetime.abort()
    const fake = fakeSpawn()
    await assert.rejects(launchRider(root, enabled, lifetime.signal, "win32", fake.spawnProcess))
    assert.deepEqual(fake.calls, [])
  })

  test("releases a pending launcher on cleanup without killing Rider", async () => {
    const lifetime = new AbortController()
    const fake = fakeSpawn()
    const launching = launchRider(root, enabled, lifetime.signal, "win32", fake.spawnProcess)
    lifetime.abort(new Error("Plugin unloaded"))
    await assert.rejects(launching, /Plugin unloaded/)
    assert.equal(fake.unreferenced(), true)
  })

  test("passes paths literally to a real subprocess on the host platform", async () => {
    const output = join(root, "arguments.json")
    const target = join(root, "feature & $(); 'quoted'", "App.slnx")
    const temporary = JSON.stringify(`${output}.tmp`)
    const script = [
      'import { writeFileSync, renameSync } from "node:fs"',
      `writeFileSync(${temporary}, JSON.stringify(process.argv.slice(1)))`,
      `renameSync(${temporary}, ${JSON.stringify(output)})`,
    ].join("\n")
    const options = worktreeOptions({ openWorktrees: true, riderCommand: [process.execPath, "--input-type=module", "-e", script] })
    await launchRider(target, options, new AbortController().signal)
    let argumentsText: string | undefined
    for (let i = 0; i < 200 && argumentsText === undefined; i++) {
      try { argumentsText = await readFile(output, "utf8") }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await setTimeout(10)
      }
    }
    assert.ok(argumentsText, "Launcher subprocess did not write its arguments")
    assert.deepEqual(JSON.parse(argumentsText), [target])
  })
})

# OpenCode Rider hooks

Formats changed C# files with Rider and reports diagnostics after OpenCode V2's
`write`, `edit`, and `patch` tools finish. Formatter diffs and diagnostics appear
in the edit's tool result. It can optionally launch Rider for linked worktree
sessions on macOS and Windows.

## Setup

Add the plugin to your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:ThisDevDane/opencode-rider-hooks"]
}
```

Keep your solution open in Rider and connect a `rider` MCP server that exposes
`rider_reformat_file` and `rider_lint_files`. No `src` directory is required.

Run `/rider-status` to check the setup. If the command is missing, run
`opencode plugin list` to verify loading. Use `/mcps` to manage the Rider connection.

To disable the plugin, append `"-opencode-rider-hooks"` to the `plugins` array in
your project's `opencode.jsonc`.

## Check the setup

`/rider-status` reports whether the plugin is loaded, the session is in this
checkout, the `rider` MCP server is configured and connected, and both required
tools are available. It also validates a configured project selector, or reports
automatic project selection when none is set. It also reports worktree auto-open
status and configuration conflicts. Each invocation reads the current connection
state and tool catalog.

The command submits the collected report as a normal prompt so the session's
selected model can display it in an assistant reply. It requires a working model
connection and uses model tokens. The assistant is instructed to present the
report without calling tools or performing additional checks.

The setup check itself does not launch Rider, execute Rider tools, change files,
request permissions, or run tests. An available tool does not prove permission is granted
or that Rider can match an open project. Those checks happen on the next eligible
C# edit.

## Project selection

Paths resolve against the session's working directory and are sent to Rider as
canonical absolute paths. Files outside the current checkout, deleted files,
generated C# files, `bin`, and `obj` are excluded.

The plugin reads the effective configuration of the MCP server named `rider`.
It uses `IJ_MCP_SERVER_PROJECT_PATH` when present, from HTTP `headers` or the
stdio `environment`. A stdio server can also inherit the variable from OpenCode's
environment. For example, a project-scoped HTTP connection can specify:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "rider": {
        "type": "remote",
        "url": "http://localhost:64342/stream",
        "headers": {
          "IJ_MCP_SERVER_PROJECT_PATH": "/absolute/path/to/checkout/backend"
        }
      }
    }
  }
}
```

Use the endpoint copied from your Rider settings. With a configured selector,
the plugin only selects files under that directory, or the containing directory
if the selector names a file. It batches those files and leaves project selection
to the connection, without overriding it with a `projectPath` argument. An
invalid, missing-on-disk, or out-of-checkout selector produces a skip report;
the plugin does not silently switch projects.

Without a configured selector, the plugin sends one request per changed file,
using the file's absolute path as the `projectPath` argument. Rider's own resolver
then selects the open project containing that path, preferring the most specific
matching directory. This supports monorepos, `.sln`, `.slnx`, standalone `.csproj`
projects, and nested sessions without scanning solution files or guessing which
project is open. Unresolved or ambiguous matches produce Rider's error in the
report; other files still run. Projects must already be open unless worktree
auto-open is enabled below.

Both formatting and linting accept absolute file paths in the current
[JetBrains implementation](https://github.com/JetBrains/intellij-community/blob/master/plugins/mcp-server/mcpserver.toolsets/src/general/RequestPathValidationSupport.kt).
This avoids assuming the matched Rider project's base directory equals the
checkout or the session directory. Project matching follows
[Rider's resolver](https://github.com/JetBrains/intellij-community/blob/master/plugins/mcp-server/src/com/intellij/mcpserver/impl/McpSessionProjectResolverImpl.kt).

## Worktrees

The plugin uses OpenCode's current checkout root, not the project's shared
canonical checkout. Sessions in linked worktrees, including nested session
directories, use that worktree's files for formatting and diagnostics.

By default, open the worktree's solution or project in Rider yourself. Opening only
the main checkout's solution does not cover its worktrees.

Without `IJ_MCP_SERVER_PROJECT_PATH`, each request supplies the changed file's
absolute path as `projectPath`, so Rider can select the matching open project.
If the variable is configured, it must point inside the current worktree. A selector
for the main checkout or another worktree is rejected rather than remapped or
overridden.

### Automatically open Rider

Opt in with plugin options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:ThisDevDane/opencode-rider-hooks",
      "options": {
        "openWorktrees": true
      }
    }
  ]
}
```

`openWorktrees` defaults to `false`. When enabled, the plugin requests a Rider
launch when a top-level session is created, moved, viewed, or first prompted in a
linked worktree. It also checks existing sessions in that checkout when the plugin
loads, covering sessions opened before event subscription. Each plugin instance
ignores sessions outside its checkout and child sessions. The canonical checkout
never triggers auto-open. Creating a worktree without opening a session there
does not launch Rider.

Launches are deduplicated by target path across plugin instances for the lifetime
of the OpenCode service. Closing Rider does not clear that record; reopen it
manually or restart the service. A failed launch is not retried on every event.
Reload the plugin to retry after fixing the launcher.

**`openWorktrees` and `IJ_MCP_SERVER_PROJECT_PATH` are mutually exclusive.** Remove
the project-path header from the `rider` MCP server before enabling auto-open.
This also applies to an effective stdio environment selector, including an
inherited value. If both are enabled, no Rider launch or post-edit tool calls run.
`/rider-status` and eligible edit reports explain the conflict. The plugin never
removes, remaps, or overrides the selector. Ordinary selector behavior is unchanged
when auto-open is disabled.

By default, Rider receives the worktree root directory. For a solution or project
inside a subdirectory, set `worktreeProject`, relative to each worktree root:

```jsonc
"options": {
  "openWorktrees": true,
  "worktreeProject": "backend/App.slnx"
}
```

The target must exist and stay inside the worktree, including after symlink
resolution. Directories, `.sln`, `.slnx`, `.csproj`, `.fsproj`, and `.vbproj` files
are supported. Absolute paths and paths into another checkout are rejected.

On macOS, the default launcher is `open -a Rider`. On Windows, `rider64.exe` must
be on the OpenCode service's `PATH`. Set `riderCommand` to an argument array if
your application has a versioned name or the executable is elsewhere:

macOS example:

```jsonc
"riderCommand": ["/usr/bin/open", "-a", "Rider 2026.2.app"]
```

Windows example:

```jsonc
"riderCommand": ["C:\\Program Files\\JetBrains\\JetBrains Rider\\bin\\rider64.exe"]
```

The plugin appends the absolute target as one argument. It does not use a shell,
so paths with spaces need no extra quoting. Use an executable, not a Windows
`.bat` or `.cmd` launcher. See [Rider's command-line setup](https://www.jetbrains.com/help/rider/Working_with_the_IDE_Features_from_Command_Line.html).

OpenCode's service must run on the desktop machine with access to Rider and the
same worktree paths. WSL, containers, and remote services need a separate host
bridge; the plugin does not provide one. Other operating systems require an
explicit `riderCommand`.

Launching is best-effort and does not wait for Rider to load the project or for
MCP to connect. Launch requests have a five-second deadline; Rider is not killed
when the plugin unloads. Formatting and diagnostics keep their existing behavior
and may initially fail while Rider starts. Use `/rider-status` to check the launch
request, MCP connection, and tools. A successful launch request does not prove
Rider opened the project.

## What to expect

The hook checks Rider tool availability on every eligible edit, before resolving
the session or edited file paths. If neither tool is available, it leaves the edit
result unchanged. Connecting Rider later takes effect on the next edit.

- Only changed C# files in the current checkout are processed, up to 20 per edit.
  Generated files, `bin`, `obj`, and files outside that checkout are excluded.
- Formatting follows Rider's settings and `.editorconfig`. It can change the
  whole file, not just edited lines.
- Formatting and diagnostics require separate permissions. Failures leave the
  original edit intact, and diagnostics still run if formatting fails.
- New files may reach Rider before its solution model updates. If formatting
  rejects them with "Requested files are not part of the current solution.", the
  plugin retries after 250 ms, 500 ms, 1 second, and 2 seconds. Successful retries
  are noted in the report. If rejection persists, check that the files are included
  in the open solution. Other errors and timeouts are not retried.
- No builds run. Shell edits and Rider tool calls don't trigger the hook.

All formatting finishes before diagnostics start. Each step has one permission
check and a 15-second deadline shared across its file requests and retry waits,
excluding permission prompts. Each step's combined output is capped at 12,000
characters. Skipped files and truncated output are reported. Formatting and
diagnostic statuses are recorded separately in the tool-result metadata. Rider's own
partial-result and timeout flags remain in its output.

Inspect files before retrying a timed-out format, since Rider may already have
changed them.

## Development

Node.js 24 LTS and pnpm are managed by `mise.toml`. This package is private and
intended for local use. Node runs the TypeScript directly; no build step is needed.

From a clone of this repository, install the tools and dependencies, then run
the checks:

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm test
mise exec -- pnpm check
```

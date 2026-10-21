# OpenCode Rider hooks

Formats changed C# files with Rider and reports diagnostics after OpenCode V2's
`write`, `edit`, and `patch` tools finish. Formatter diffs and diagnostics appear
in the edit's tool result.

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
automatic project selection when none is set. Each invocation reads the current
connection state and tool catalog.

The command submits the collected report as a normal prompt so the session's
selected model can display it in an assistant reply. It requires a working model
connection and uses model tokens. The assistant is instructed to present the
report without calling tools or performing additional checks.

The setup check itself does not execute Rider tools, change files, request
permissions, or run tests. An available tool does not prove permission is granted
or that Rider can match an open project. Those checks happen on the next eligible
C# edit.

## Project selection

Paths resolve against the session's working directory and are sent to Rider as
canonical absolute paths. Other checkouts, deleted files, generated C# files,
`bin`, and `obj` are excluded.

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
report; other files still run. The plugin never opens projects itself.

Both formatting and linting accept absolute file paths in the current
[JetBrains implementation](https://github.com/JetBrains/intellij-community/blob/master/plugins/mcp-server/mcpserver.toolsets/src/general/RequestPathValidationSupport.kt).
This avoids assuming the matched Rider project's base directory equals the
checkout or the session directory. Project matching follows
[Rider's resolver](https://github.com/JetBrains/intellij-community/blob/master/plugins/mcp-server/src/com/intellij/mcpserver/impl/McpSessionProjectResolverImpl.kt).

## What to expect

The hook checks Rider tool availability on every eligible edit, before resolving
the session or edited file paths. If neither tool is available, it leaves the edit
result unchanged. Connecting Rider later takes effect on the next edit.

- Only changed C# files in this checkout are processed, up to 20 per edit. Generated
  files, `bin`, `obj`, and other checkouts are excluded.
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

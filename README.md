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
`rider_reformat_file` and `rider_lint_files`. The plugin currently requires the
solution directory at `<project>/src`, with Rider resolving paths from there.
This path is hardcoded, not configurable.

Run `opencode plugin list` to verify loading and use `/mcps` to check the Rider
connection.

To disable the plugin, append `"-opencode-rider-hooks"` to the `plugins` array in
your project's `opencode.jsonc`.

## What to expect

The hook checks Rider tool availability on every eligible edit, before resolving
the session or edited file paths. If neither tool is available, it leaves the edit
result unchanged. Connecting Rider later takes effect on the next edit.

- Only changed C# files under `src` are processed, up to 20 per edit. Generated
  files, `bin`, `obj`, and other checkouts are excluded.
- Formatting follows Rider's settings and `.editorconfig`. It can change the
  whole file, not just edited lines.
- Formatting and diagnostics require separate permissions. Failures leave the
  original edit intact, and diagnostics still run if formatting fails.
- No builds run. Shell edits and Rider tool calls don't trigger the hook.

Each Rider operation has a 15-second timeout. Inspect files before retrying a
timed-out format, since Rider may already have changed them.

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

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

## What to expect

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

From a clone of this repository:

```sh
mise exec bun@1.4.3 -- bun install
mise exec bun@1.4.3 -- bun test
mise exec bun@1.4.3 -- bun run check
```

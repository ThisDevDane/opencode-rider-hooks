# Rider post-edit formatting and diagnostics

OpenCode V2 discovers this project-local plugin automatically. After successful
native `write`, `edit`, and `patch` calls, it runs Rider's `reformat_file` on the
changed C# files, then runs `lint_files`. The formatter diff and diagnostics
appear in the edit's tool result under `Rider post-edit formatting` and
`Rider post-edit diagnostics`.

Formatting uses Rider's code style settings, including the solution's
`.editorconfig`, and can change any part of each selected file. The plugin only
formats and checks files reported by the edit, not every dirty file in Git. It
does not run builds. Shell edits and edits made through Rider's own tools do not
trigger this hook, so formatter calls cannot recursively trigger it.

Paths resolve against the session's working directory, then become relative to
this checkout's `src` solution directory. Other checkouts, deleted files, generated
C# files, `bin`, and `obj` are excluded. Keep the `rider` MCP server pointed at
this checkout's `src` directory.

The hook checks `rider_reformat_file` and `rider_lint_files` permissions separately.
Unavailable, failed, or denied operations produce a message without failing the
original edit. Diagnostics still run if formatting cannot complete. A formatter
timeout does not prove that Rider made no changes; inspect the file before
retrying. Rider's own partial-result and timeout flags remain in its output.
Each edit processes at most 20 files and waits at most 15 seconds per operation,
excluding permission prompts. Each operation's output is capped at 12,000
characters. Skipped files and truncated output are reported. Formatting and
diagnostic statuses are recorded separately in the tool-result metadata.

## Code layout

- `index.ts` registers the hook and runs formatting before diagnostics.
- `files.ts` finds changed files and filters paths before sending them to Rider.
- `rider.ts` calls Rider, checks permissions, and appends bounded reports to the
  original edit result. Each step handles its own failure.
- `test/post-edit.test.ts` covers file selection, reporting, and the hook's behavior.
- `test/fake-opencode.ts` provides the test client and simulated Rider responses.

Keep Rider open with the solution loaded. Verify the plugin with
`opencode plugin list` from the repository root. To disable it, append
`"-local.rider-post-edit"` to the project's `plugins` array in
`.opencode/opencode.json`.

Run the plugin's checks from this directory:

```sh
mise exec bun@1.4.3 -- bun install
mise exec bun@1.4.3 -- bun test
mise exec bun@1.4.3 -- bun run check
```

# tool-status

A Claude Code mod that says what the agent is doing while it works, and keeps
the transcript's tool rows short until you ask for more.

**Spinner.** While a tool runs, the spinner names it and counts its time, with
what the call is doing on the line under it:

```
✻ Bash 12s (+1 more)
  Run the test suite
```

Between calls it says what the turn is doing in place of the random verb, and
how long since the last call ended (`✗` if it failed):

```
✻ Thinking… 5s since Bash (12.4s)
  Run the test suite
```

Subagents' spinners follow their own calls. A state the engine names
(compacting, a retry) still shows as the engine draws it.

**Tool rows.** Every tool row gets a line naming the call, with the lines it
added and removed, its time (counting up while it runs), and any failure in red:

```
  Edit register.tsx · +12/-3
  Run the test suite · ✗ failed after 4.2s
```

`/tool-detail [none|compact|input|full]` sets how much of every row shows:

| detail | the row draws |
| --- | --- |
| `none` (the default) | the line alone |
| `compact` | inputs cut to 10 lines, outputs to 5 |
| `input` | inputs and the line, no outputs |
| `full` | the engine's own row, and the line |

Without an argument it steps to the next one. The choice is kept across
sessions. Clicking a row's line steps that row alone: left click forward, right
or ctrl+click back. The next `/tool-detail` resets every row. The ctrl+o
transcript always draws rows in full.

When a turn ends, a line sums it up: `14 tools (1 failed) · +120/-30 lines · slowest: Run tests 38s`.

## Option

`requireBashDescription` (off by default) refuses any Bash call that has no
`description` and asks the model to retry with one. Turn it on in `/config`, or
in `~/.claude/settings.json`:

```json
"pluginConfigs": { "tool-status": { "options": { "requireBashDescription": true } } }
```

## Install

From a clone of this repository, either name it in `~/.claude/settings.json` so
every session loads it from the working copy:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/tool-status" }
```

or install it from the clone, which is also a marketplace:

```
claude plugin install tool-status --marketplace /path/to/tool-status
```

## Developing

```
claude plugin validate .
claude plugin test .
```

Once a session has loaded the mod from this folder, `tsc -p .` type-checks it
against the engine's types, which the engine writes into
`.claude-plugin/types/` (git ignores that folder).

## History

This mod merges three separate mods that grew on three machines. Each is kept
verbatim (less the engine-generated types) as a root commit on its own branch
and tag. The first commit on `main` merges all three:

| branch / tag | mod | where it ran |
| --- | --- | --- |
| `legacy/spinner-detail`, `legacy/spinner-detail-v0.1.0` | spinner-detail 0.1.0 | machine A (WSL) |
| `legacy/tool-status`, `legacy/tool-status-v0.8.0` | tool-status 0.8.0 | machine B (Termux) |
| `legacy/spinner-tool-desc`, `legacy/spinner-tool-desc-v0.2.0` | spinner-tool-desc 0.2.0 | machine C (Windows) |

`git show legacy/tool-status:hooks/register.tsx` prints an old file;
`git log --graph --all` shows how they meet.

What 1.0.0 took from each:

- **spinner-tool-desc:** the per-loop spinner (subagents apart), mode labels
  in place of the random verb, failure marks, the four details with per-row
  clicks through a `Client`, `compact` cutting values while keeping their
  shape, notebook diffs, the turn summary, and `Worked` on the turn's last line.
- **tool-status:** the two-line spinner (the tool on top, what it is doing
  whole under it), the running row's live time, Bash `bashEditDiff` counts,
  deferring to the engine's own spinner states, the cleanup of a call that
  faults in the mod, and the theme's `success`/`error` colours.
- **spinner-detail:** the `/tool-detail` name, stepping it without an
  argument, the `backgrounded` mark, the Bash-description rule (now an option,
  off by default), and diff counts read from any result's shape.

Left behind:

- spinner-detail's swap to the background job's `state.json` detail, which
  polled a file every 500 ms forever. It also put a session-level summary where
  the call's own description belongs.
- spinner-detail's `then Xs` gap after each call.
- hiding the run-in-background hint, so `ctrl+b` stays discoverable.
- the old names and stored values (`/transcript-tool-detail`, `/tool-output`,
  `preview`, `inputs`, `input-only`, `default`, `partial`), and the code that
  migrated them.

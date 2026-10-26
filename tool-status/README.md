# tool-status

A Claude Code mod that says what the agent is doing while it works, and keeps
the transcript's tool rows and other parties' messages short until you ask for
more.

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

In the ctrl+o transcript the line opens with the call's place since your
prompt; an interrupted turn's count carries on into the next prompt, and a
subagent's calls are not numbered:

```
  3. Edit register.tsx · +12/-3
```

`/tool-detail [none|compact|input|full]` sets how much of every row shows:

| detail | the row draws |
| --- | --- |
| `none` (the default) | the line alone |
| `compact` | inputs cut to 10 lines, outputs to 5 |
| `input` | inputs and the line, no outputs |
| `full` | the engine's own row, and the line |

- Without an argument it steps to the next one; the choice is kept across
  sessions.
- Clicking a row's line steps that row alone: left click forward, right or
  ctrl+click back. The next `/tool-detail` resets every row.
- The ctrl+o transcript follows the same choices, and shows each row of a run
  the main view folds into one line (`Ran 2 shell commands`).

**Messages.** In the ctrl+o transcript, a message another agent, teammate,
session or channel sent folds the same way, to a line naming its sender with
its first line and length; `compact` cuts the body to 10 lines, `input` and
`full` show it whole, and a click steps it as it does a tool row:

```
  Explore: Found three call sites of setLoop · 42 lines
```

## Options

`requireBashDescription`, off by default, refuses any Bash call that has no
`description` and asks the model to retry with one. Turn it on in `/config`, or
in `~/.claude/settings.json`, keyed by the installed id (`tool-status` alone is
ignored):

```json
"pluginConfigs": { "tool-status@asemptote": { "options": { "requireBashDescription": true } } }
```

`numberRows`, on by default, numbers the rows in ctrl+o; turn it off to drop
the numbers. Set it the same way.

## Install

Once [claude-mods](../) is added as a marketplace (see its README):

```
claude plugin install tool-status@asemptote
```

## Developing

From the repository's root:

```
claude plugin validate tool-status
claude plugin test tool-status
```

Loaded from a folder (`--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`), its options
are keyed `tool-status@inline`.

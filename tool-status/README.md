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

**Tool rows.** Every tool row is headed by a line naming the call, with the lines it
added and removed, how long its input and output were, its time (counting up
while it runs), and any failure in red:

```
  Edit register.tsx · +12/-3
  Run the test suite · 42 → 31k chars · 4.2s
  Read config.json · → 2.9k chars
  Deploy it · ✗ failed after 4.2s
```

The size is in characters, exact under a hundred, then cut short (`0.1k`,
`1.2k`, `31k`, `1.2M`), in then out: in, a command or prompt; out, a shell's
stdout and stderr, a read's content, a search's matches or file list, an
agent's or MCP tool's text, a fetch's result. A file change has its +/-
instead. A running call shows its input's size, and its output's once it
finishes: the engine hands a mod no output while a tool runs.

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
- Past `none`, the line heads the row and a dim rule closes it, under its
  output (in `input`, under its input), in place of a blank line between rows.
- Clicking a row's line steps that row alone: left click forward, right or
  ctrl+click back. The next `/tool-detail` resets every row.
- The ctrl+o transcript follows the same choices, and shows each row of a run
  the main view folds into one line (`Ran 2 shell commands`).

**Highlighted commands.** In `compact` and `input`, a Bash or PowerShell
row draws its command highlighted, and each piece of code it hands another
language in that language, on rows of its own:

- a heredoc's body, by the program it is fed to (`uv run python - <<'EOF'`,
  `psql <<SQL`), or the file it is written to (`cat > run.py <<EOF`);
- a PowerShell here-string, piped in (`@'…'@ | python -`), passed
  (`python -c @'…'@`) or written (`Set-Content run.js -Value @'…'@`);
- a multi-line `-c`/`-e` argument (`python -c "…"`, `node -e '…'`); a
  one-line one stays in the shell's row.

Shell code inside another shell (`bash -c '…'`, `ssh host '…'`, `pwsh -c
"…"`) is split again by that shell's rules. A heredoc nobody reads as code (a
commit message) is plain text. The row's line heads it, the code under it
behind a dim bar:

```
  Dump the config · 81 → 2.4k chars · 2.3s
  ▎ cd src && uv run python - <<'EOF'
  ▎ import json
  ▎ print(json.dumps(config))
  ▎ EOF
```

`full` draws the engine's own row.

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
the numbers. `highlightCommands`, on by default, draws commands highlighted as
above; turn it off for the engine's own row in every detail. Set them the same
way.

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

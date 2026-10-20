# claude-mods

My Claude Code mods, one folder each. The repository is also a plugin
marketplace, so any of them installs from a clone or from GitHub.

| mod | what it does |
| --- | --- |
| [tool-status](tool-status/) | Names the running tool call on the spinner, and gives every tool row a line with its diff, time and any failure; `/tool-detail` sets how much of each row shows. |

## Install

Once per machine, add a clone as a marketplace:

```
git clone <this repository> ~/claude-mods
claude plugin marketplace add ~/claude-mods
```

Then install each mod you want:

```
claude plugin install tool-status@claude-mods
```

A mod installed from a folder marketplace runs from the clone itself: after a
`git pull`, `/reload-plugins` picks the change up with no reinstall.

From GitHub instead, at the prompt of a terminal session:

```
/plugin install tool-status --marketplace <owner>/claude-mods
```

## Layout

```
.claude-plugin/marketplace.json   lists every mod and its folder
<mod>/.claude-plugin/plugin.json  the mod's manifest and version
<mod>/hooks/                      hooks.json and the hooks module
<mod>/types/index.d.ts            the mod's $.state contract
<mod>/tests/                      claude plugin test <mod>
<mod>/README.md                   what it does, its options, its history
```

A new mod gets a folder of its own and an entry in `marketplace.json`. Check
it with:

```
claude plugin validate <mod>
claude plugin test <mod>
```

The engine writes each mod's API types into `<mod>/.claude-plugin/types/`
when a session loads it from its folder (git ignores them), and `tsc -p <mod>`
then type-checks it.

## History

Branches and tags under `legacy/` hold mods as they were before they came into
this repository. Each one is a root commit, a verbatim snapshot with the mod's
files at the top level. `tool-status` merged three of them; its README says
what it took from each.

| branch / tag | mod | where it ran |
| --- | --- | --- |
| `legacy/spinner-detail`, `legacy/spinner-detail-v0.1.0` | spinner-detail 0.1.0 | machine A (WSL) |
| `legacy/tool-status`, `legacy/tool-status-v0.8.0` | tool-status 0.8.0 | machine B (Termux) |
| `legacy/spinner-tool-desc`, `legacy/spinner-tool-desc-v0.2.0` | spinner-tool-desc 0.2.0 | machine C (Windows) |

`git show legacy/tool-status:hooks/register.tsx` prints an old file;
`git log --graph --all` shows where they meet.

## License

MIT. See [LICENSE](LICENSE).

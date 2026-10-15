import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Diff, Finished, Head, Running, Timing, View } from '../types'

// The tool calls in flight, oldest first. Parallel calls share the one spinner
// line, so it names the newest's tool, counts the rest, and puts what the
// newest is doing, whole, on the line under it.
const running = atom({ plugin: 'tool-status', key: 'running' } as const, [] as Running[])
// The call that finished last, shown with its age and how long it ran while
// nothing runs.
const last = atom({ plugin: 'tool-status', key: 'last' } as const, null as Finished | null)
// The time ages are measured to: the idle line's, and a running row's elapsed
// time. Ticks once a second through a turn. Older than a call's own times it
// reads as 0s, `age` flooring at zero, so a call need not write it.
const now = atom({ plugin: 'tool-status', key: 'now' } as const, 0)
// How much of each call tool rows draw; /tool-output sets it, $.store keeps it.
const view = atom({ plugin: 'tool-status', key: 'view' } as const, 'full' as View)
// The head of what each call returned, by its tool_use_id: the one text every
// tool has (`tool.call`'s `text`), where the result's own shape varies by tool.
const outputs = atom({ plugin: 'tool-status', key: 'outputs' } as const, null as Head | null)
// When each call started and, once it ends, how long it ran, by its tool_use_id.
const timings = atom({ plugin: 'tool-status', key: 'timings' } as const, null as Timing | null)

const INPUT_LINES = 10
const OUTPUT_LINES = 5
const VIEWS: readonly View[] = ['none', 'compact', 'inputs', 'full']
const SAYS: Record<View, string> = {
  none: 'Tool rows show only the description.',
  compact: `Tool rows show ${INPUT_LINES} lines of input and ${OUTPUT_LINES} of output.`,
  inputs: 'Tool rows show their input, not their output.',
  full: 'Tool rows show their full input and output.',
}

// The input fields that say what a call is doing, most telling first.
const FIELDS = ['description', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'subject', 'prompt', 'command', 'message']

// The first line of the field that says what a call is doing, whole.
export function mainOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const fields = input as Record<string, unknown>
  for (const field of FIELDS) {
    const value = fields[field]
    if (typeof value !== 'string') continue
    const text = value.trim().split('\n')[0] ?? ''
    if (text !== '') return text
  }
  return undefined
}

export function valueOf(input: unknown): string | undefined {
  const text = mainOf(input)
  if (text === undefined) return undefined
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

// A finished call's run time: tenths under ten seconds, where most calls land.
export function took(ms: number): string {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : age(ms)
}

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// `/tool-output` alone steps to the next view; null for an argument it does not know.
export function chosen(args: string, current: View): View | null {
  const arg = args.trim().toLowerCase()
  if (arg === '') return VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length] ?? 'full'
  return VIEWS.find(v => v === arg) ?? null
}

// Kept lines are cut at 500 characters: each is drawn on one row anyway, and a
// minified file read must not bloat the session's state.
export function head(text: string, count: number): Head {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '') return { lines: [], more: 0 }
  return { lines: lines.slice(0, count).map(l => l.slice(0, 500)), more: Math.max(0, lines.length - count) }
}

// Each text field cut to its head (emptied at 0), for the engine's own header to
// draw: a rewritten `input` changes the row alone, the call having already run.
export function capped(input: unknown, count: number): unknown {
  if (typeof input !== 'object' || input === null) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value]
    if (count === 0) return [key, '']
    const { lines, more } = head(value, count)
    return [key, more > 0 ? `${lines.join('\n')}\n… +${more} lines` : value]
  }))
}

// For a row whose call this session never saw (a resumed one): a Bash record's
// streams, or a result that is plain text.
export function storedText(output: unknown): string | undefined {
  if (typeof output === 'string') return output
  const { stdout, stderr } = (output ?? {}) as { stdout?: unknown; stderr?: unknown }
  if (typeof stdout !== 'string') return undefined
  return typeof stderr === 'string' && stderr !== '' ? `${stdout}\n${stderr}` : stdout
}

type Hunk = { lines?: unknown }
const counted = (hunks: Hunk[]) => hunks.flatMap(h => (Array.isArray(h.lines) ? h.lines : [])).reduce(
  (n: Diff, line) => typeof line !== 'string' ? n
    : line.startsWith('+') ? { added: n.added + 1, removed: n.removed }
    : line.startsWith('-') ? { added: n.added, removed: n.removed + 1 } : n,
  { added: 0, removed: 0 },
)

// The lines a call added and removed, from the patch its stored result carries:
// Edit's and Write's `structuredPatch`, a Bash call's `bashEditDiff`. A Write
// that creates a file may carry no patch, so its content is the count.
export function diffOf(output: unknown): Diff | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const o = output as { staged?: unknown; structuredPatch?: unknown; type?: unknown; content?: unknown; originalFile?: unknown; bashEditDiff?: unknown }
  if (o.staged === true) return undefined
  if (Array.isArray(o.structuredPatch)) {
    if (o.structuredPatch.length > 0) return counted(o.structuredPatch as Hunk[])
    if (o.type === 'create' && typeof o.content === 'string') return { added: head(o.content, 0).more, removed: 0 }
    return typeof o.originalFile === 'string' ? { added: 0, removed: 0 } : undefined
  }
  const files = (o.bashEditDiff as { files?: unknown } | undefined)?.files
  if (!Array.isArray(files) || files.length === 0) return undefined
  return counted(files.flatMap((f: { hunks?: unknown }) => (Array.isArray(f.hunks) ? f.hunks as Hunk[] : [])))
}

// Sets the view `args` names, or the next one; null for a name it does not know.
async function choose($: EngineInterface, args: string): Promise<View | null> {
  const picked = chosen(args, await read($, view))
  if (picked === null) return null
  await update($, view, () => picked)
  await $.store.set('view', picked)
  return picked
}

export const register: Register = on => {
  let ticker: Timer | undefined

  on('session.start', async ($, e, next) => {
    // `compact: true` is what 0.5.0 stored before there were four views.
    const stored = (await $.store.get('view')) ?? ((await $.store.get('compact')) === true ? 'compact' : undefined)
    const known = VIEWS.find(v => v === stored)
    if (known !== undefined) await update($, view, () => known)
    await $.command.register({
      name: 'tool-output',
      description: `Choose what tool rows show: none (the description), compact (${INPUT_LINES} lines of input, ${OUTPUT_LINES} of output), inputs, or full`,
      argumentHint: '[none|compact|inputs|full]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'tool-output' }, async ($, e) => {
    const picked = await choose($, e.args)
    if (picked === null) return { text: `Unknown argument "${e.args.trim()}": use ${VIEWS.join(', ')}, or nothing for the next one.` }
    return { text: SAYS[picked] }
  })

  on('turn.start', ($, e, next) => {
    // A write redraws only what reads it: the idle line, and running rows.
    ticker ??= $.clock.every(1000, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
    })
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      ticker?.cancel()
      ticker = undefined
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const call = { label: e.tool, detail: mainOf(e) }
    const timing = memberOf(timings, { requestId: id })
    const startedAt = await $.clock.now()
    await update($, timing, () => ({ startedAt }))
    await update($, running, all => [...all, { id, ...call }])
    try {
      const result = await next(e)
      const text = 'deny' in result && result.deny !== undefined ? result.deny : result.text
      if (text !== undefined) await update($, memberOf(outputs, { requestId: id }), () => head(text, OUTPUT_LINES))
      return result
    } finally {
      // The call is the idle line before it leaves the spinner: each write
      // redraws, so leaving first drew the call before it in between.
      const endedAt = await $.clock.now()
      await update($, last, () => ({ ...call, endedAt, ms: endedAt - startedAt }))
      await update($, timing, () => ({ startedAt, ms: endedAt - startedAt }))
      await update($, running, all => all.filter(r => r.id !== id))
    }
  })
    // A failure here must never cost the call, nor leave it on the spinner.
    .catch(async ($, e, next) => {
      await update($, running, all => all.filter(r => r.id !== e.tool_use_id))
      return next(e)
    })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const all = await read($, running)
    const newest = all.at(-1)
    const finished = newest === undefined ? await read($, last) : null
    let message, detail
    if (newest !== undefined) {
      message = all.length > 1 ? `${newest.label} (+${all.length - 1} more)` : newest.label
      detail = newest.detail
    } else if (finished !== null && e.props.message === null) {
      const ran = finished.ms === undefined ? '' : ` ${took(finished.ms)}`
      message = `${age((await read($, now)) - finished.endedAt)} ago · ${finished.label}${ran}`
      detail = finished.detail
    } else {
      // A message the engine set (compacting, a retry) outranks the idle line.
      return next(e)
    }
    const line = await next({ ...e, props: { ...e.props, message } })
    if (detail === undefined) return line
    const { Box, Text } = $.ui.resolve(e)
    // Under the message, past the engine's two-cell glyph, wrapping there; bold
    // in the spinner's color by the theme's key, as the rows' descriptions are.
    return (
      <Box flexDirection="column">
        {line}
        <Box paddingLeft={2}><Text bold color="claude">{detail}</Text></Box>
      </Box>
    )
  })

  // Keeps what a call was doing on its own transcript row, under its
  // header. Rows folded into a group's count line are not drawn one by one.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const shown = await read($, view)
    const lines = shown === 'none' ? 0 : shown === 'compact' ? INPUT_LINES : undefined
    const row = await next(lines === undefined ? e : { ...e, props: { ...e.props, input: capped(e.props.input, lines) } })
    const { Box, Button, Text } = $.ui.resolve(e)
    // The header already draws the call's input (`Bash(ls -la)`), so the line under
    // it adds only the description, whole outside the full view.
    const value = shown === 'full' ? valueOf(e.props.input) : mainOf(e.props.input)
    // Only calls this session ran have a time; a resumed row's result holds none.
    const timing = await read($, memberOf(timings, { requestId: e.props.tool_use_id }))
    const time = timing === null ? undefined
      : timing.ms !== undefined ? took(timing.ms)
      : e.props.isRunning ? age((await read($, now)) - timing.startedAt) : undefined
    if (value === undefined && time === undefined) return row
    const diff = diffOf(e.props.output)
    const press = () => choose($, '')
    let description
    if (value !== undefined) try {
      // The spinner's color, by the theme's key so it follows light and dark.
      description = (
        <Button key="view" plain onPress={press}>
          <Text bold color="claude">{value}</Text>
          {time !== undefined && <Text dimColor>{` ${time}`}</Text>}
        </Button>
      )
    } catch {
      // 2.1.291, the `claude --previous` build, refuses a Button any child but a string.
      description = <Button key="view" plain label={time === undefined ? value : `${value} ${time}`} onPress={press} />
    }
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row">
          <Text dimColor>  ↳ </Text>
          {diff && <Text color="success">+{diff.added}</Text>}
          {diff && <Text dimColor>/</Text>}
          {diff && <Text color="error">-{diff.removed} </Text>}
          {/* A Button's own box never shrinks: alone in the row it overran the
              edge and squeezed the arrow and the time into slivers. */}
          <Box flexDirection="column" flexShrink={1}>{description ?? <Text dimColor>{time}</Text>}</Box>
        </Box>
      </Box>
    )
  })

  // Lines are cut at the edge, not wrapped, so the head stays that many rows.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const current = await read($, view)
    if (current === 'full') return next(e)
    if (current !== 'compact') {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    const stored = storedText(e.props.output)
    const shown = (await read($, memberOf(outputs, e))) ?? (stored === undefined ? null : head(stored, OUTPUT_LINES))
    if (shown === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {shown.lines.length === 0 && <Text dimColor>  ⎿ (no output)</Text>}
        {shown.lines.map((line, i) => <Text dimColor wrap="truncate-end">{i === 0 ? '  ⎿ ' : '    '}{line}</Text>)}
        {shown.more > 0 && <Text dimColor>    … +{shown.more} lines</Text>}
      </Box>
    )
  })
}

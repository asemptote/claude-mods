import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Finished, Head, Running, View } from '../types'

// The tool calls in flight, oldest first. Parallel calls share the one spinner
// line, so it shows the newest and counts the rest.
const running = atom({ plugin: 'tool-status', key: 'running' } as const, [] as Running[])
// The call that finished last, shown with its age while nothing runs.
const last = atom({ plugin: 'tool-status', key: 'last' } as const, null as Finished | null)
// The time the age is measured to; ticks once a second while a turn shows it.
const now = atom({ plugin: 'tool-status', key: 'now' } as const, 0)
// How much of each call tool rows draw; /tool-output sets it, $.store keeps it.
const view = atom({ plugin: 'tool-status', key: 'view' } as const, 'full' as View)
// The head of what each call returned, by its tool_use_id: the one text every
// tool has (`tool.call`'s `text`), where the result's own shape varies by tool.
const outputs = atom({ plugin: 'tool-status', key: 'outputs' } as const, null as Head | null)

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

// A Bash call's description stands alone; any other call is named by its tool.
export function labelOf(tool: string, input: unknown): string {
  const description = (input as { description?: unknown } | null)?.description
  if (tool === 'Bash' && typeof description === 'string' && description !== '') return description
  const value = valueOf(input)
  return value === undefined ? tool : `${tool} ${value}`
}

// The idle line keeps only the start of the last call's label, short enough for
// a narrow terminal; the spinner's own ellipsis follows it.
export function firstWords(label: string): string {
  const words = label.split(/\s+/).slice(0, 3).join(' ')
  return words.length > 32 ? words.slice(0, 32) : words
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
    ticker ??= $.clock.every(1000, async () => {
      // Only the idle line shows an age; a write redraws just the spinner.
      if ((await read($, running)).length === 0 && (await read($, last)) !== null) {
        const t = await $.clock.now()
        await update($, now, () => t)
      }
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
    const label = labelOf(e.tool, e)
    await update($, running, all => [...all, { id, label }])
    try {
      const result = await next(e)
      const text = 'deny' in result && result.deny !== undefined ? result.deny : result.text
      if (text !== undefined) await update($, memberOf(outputs, { requestId: id }), () => head(text, OUTPUT_LINES))
      return result
    } finally {
      await update($, running, all => all.filter(r => r.id !== id))
      const endedAt = await $.clock.now()
      await update($, now, () => endedAt)
      await update($, last, () => ({ label, endedAt }))
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
    if (newest !== undefined) {
      const message = all.length > 1 ? `${newest.label} (+${all.length - 1} more)` : newest.label
      return next({ ...e, props: { ...e.props, message } })
    }
    const finished = await read($, last)
    // A message the engine set (compacting, a retry) outranks the idle line.
    if (finished === null || e.props.message !== null) return next(e)
    const message = `${age((await read($, now)) - finished.endedAt)} ago · ${firstWords(finished.label)}`
    return next({ ...e, props: { ...e.props, message } })
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
    if (value === undefined) return row
    const press = () => choose($, '')
    let description
    try {
      // The spinner's color, by the theme's key so it follows light and dark.
      description = (
        <Button key="view" plain onPress={press}>
          <Text bold color="claude">{value}</Text>
        </Button>
      )
    } catch {
      // 2.1.291, the `claude --previous` build, refuses a Button any child but a string.
      description = <Button key="view" plain label={value} onPress={press} />
    }
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row">
          <Text dimColor>  ↳ </Text>
          {description}
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

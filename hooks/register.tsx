import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Finished, Running } from '../types'

// The tool calls in flight, oldest first. Parallel calls share the one spinner
// line, so it shows the newest and counts the rest.
const running = atom({ plugin: 'tool-status', key: 'running' } as const, [] as Running[])
// The call that finished last, shown with its age while nothing runs.
const last = atom({ plugin: 'tool-status', key: 'last' } as const, null as Finished | null)
// The time the age is measured to; ticks once a second while a turn shows it.
const now = atom({ plugin: 'tool-status', key: 'now' } as const, 0)

// The input fields that say what a call is doing, most telling first.
const FIELDS = ['description', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'subject', 'prompt', 'command', 'message']

export function valueOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const fields = input as Record<string, unknown>
  for (const field of FIELDS) {
    const value = fields[field]
    if (typeof value !== 'string') continue
    const text = value.trim().split('\n')[0] ?? ''
    if (text !== '') return text.length > 80 ? `${text.slice(0, 79)}…` : text
  }
  return undefined
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

export const register: Register = on => {
  let ticker: Timer | undefined

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
      return await next(e)
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

  // Keeps what a call was doing on its own transcript row, dim, under its
  // header. Rows folded into a group's count line are not drawn one by one.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    const value = valueOf(e.props.input)
    if (value === undefined) return row
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        <Text dimColor>  ↳ {value}</Text>
      </Box>
    )
  })
}

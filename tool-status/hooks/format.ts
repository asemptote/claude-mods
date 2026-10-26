// What the hooks draw, from plain values: no `$`, so the tests call it directly.

import type { Detail } from '../types'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** A call as the spinner and its row name it. */
export type Described = {
  /** The tool, an MCP tool as `server:tool`: the spinner's first line. */
  label: string
  /** What the call is doing (its description, else its most telling argument): the line under it. */
  detail: string | undefined
  /** The row's line: the description alone, else the label with its argument. */
  text: string
}

const MAX_LENGTH = 160
const PATH_ARGS = ['file_path', 'notebook_path']
const TEXT_ARGS = ['pattern', 'url', 'query', 'skill', 'subject', 'command', 'prompt', 'message']

// The first non-blank line, its runs of space collapsed, cut past MAX_LENGTH.
export const firstLine = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const line = value.split('\n').find(l => l.trim() !== '')
  if (line === undefined) return undefined
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH - 1)}…` : flat
}

export const toolLabel = (tool: string): string => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${mcp[1]}:${mcp[2]}` : tool
}

export function describe(tool: string, input: unknown): Described {
  const label = toolLabel(tool)
  const args = isRecord(input) ? input : {}
  const own = firstLine(args.description)
  if (own !== undefined) return { label, detail: own, text: own }
  for (const key of PATH_ARGS) {
    const path = firstLine(args[key])
    if (path !== undefined) {
      const name = path.split(/[\\/]/).pop() || path
      return { label, detail: name, text: `${label} ${name}` }
    }
  }
  for (const key of TEXT_ARGS) {
    const text = firstLine(args[key])
    if (text !== undefined) return { label, detail: text, text: `${label} ${text}` }
  }
  return { label, detail: undefined, text: label }
}

/** How long ago, or how long so far: whole seconds, then minutes, then hours. */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** How long a finished call ran: tenths under ten seconds, where most calls land. */
export const took = (ms: number): string => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : age(ms))

export type Diff = { added: number; removed: number }

export const lineCount = (text: string) => (text === '' ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length)

const counted = (hunks: unknown[]): Diff => {
  const diff = { added: 0, removed: 0 }
  for (const hunk of hunks) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) diff.added++
      else if (line.startsWith('-')) diff.removed++
    }
  }
  return diff
}

// The lines a call added and removed, read from the shape of its stored result
// whatever the tool: a `structuredPatch` (Edit, Write), a created file's
// content, a Bash call's `bashEditDiff`.
export function diffOf(output: unknown): Diff | undefined {
  if (!isRecord(output) || output.staged === true || typeof output.error === 'string') return undefined
  if (Array.isArray(output.structuredPatch) && output.structuredPatch.length > 0) return counted(output.structuredPatch)
  if (output.type === 'create' && typeof output.content === 'string') return { added: lineCount(output.content), removed: 0 }
  const bash = output.bashEditDiff
  if (isRecord(bash) && Array.isArray(bash.files) && bash.files.length > 0) {
    return counted(bash.files.flatMap(file => (isRecord(file) && Array.isArray(file.hunks) ? file.hunks : [])))
  }
  return undefined
}

/** A transcript row as `$.session.messages()` gives it, as much as numbering reads. */
export type Row = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ReadonlyArray<{ tool_use_id: string }>
  toolResults?: readonly unknown[]
}

/** The transcript's calls numbered, and where the count stands at its end. */
export type Numbered = {
  numbers: Map<string, number>
  count: number
  /** Whether the last turn was answered, so the next prompt counts from 1. */
  isAnswered: boolean
}

const INTERRUPTED = '[Request interrupted by user'

// Each call's place among the calls since its prompt, from 1, read from the
// transcript for the calls this process did not see run. A prompt starts a
// count only after an answer (or opening the transcript): one after a tool
// result or an interruption goes on with the count, as it does live.
export function numberCalls(rows: readonly Row[]): Numbered {
  const numbers = new Map<string, number>()
  let count = 0
  let isAnswered = true
  for (const row of rows) {
    if (row.role === 'assistant') {
      for (const use of row.toolUses) numbers.set(use.tool_use_id, ++count)
      isAnswered = row.toolUses.length === 0
    } else if ((row.toolResults?.length ?? 0) > 0 || row.text.startsWith(INTERRUPTED)) isAnswered = false
    else if (isAnswered && row.text.trim() !== '') count = 0
  }
  return { numbers, count, isAnswered }
}

// Each multi-line string, and each run of strings (a hunk's lines, a list of
// files), cut to `max` lines, the last saying how many are left out. The cut
// keeps the value's shape, so the tool's own renderer still draws it.
export function compact(value: unknown, max: number): unknown {
  if (typeof value === 'string') {
    const lines = value.split('\n')
    if (lines.length <= max) return value
    return [...lines.slice(0, max - 1), `… +${lines.length - max + 1} lines`].join('\n')
  }
  if (Array.isArray(value)) {
    if (value.length > max && value.every(item => typeof item === 'string')) {
      // A leading space keeps the marker a context line inside a diff hunk.
      return [...value.slice(0, max - 1), ` … +${value.length - max + 1} more`]
    }
    return value.map(item => compact(item, max))
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, max)]))
  return value
}

export const INPUT_LINES = 10
export const OUTPUT_LINES = 5

/** In the order `/tool-detail` and a click step through them, least first. */
export const DETAILS: Record<Detail, string> = {
  none: 'the line alone',
  compact: `inputs cut to ${INPUT_LINES} lines, outputs to ${OUTPUT_LINES}`,
  input: 'inputs and the line, no outputs',
  full: 'tool rows drawn in full',
}
const CYCLE = Object.keys(DETAILS) as Detail[]
export const DETAIL_OPTIONS = CYCLE.join('|')

export const parseDetail = (text: string): Detail | undefined => CYCLE.find(detail => detail === text.trim().toLowerCase())

export const stepDetail = (detail: Detail, step: 1 | -1): Detail =>
  CYCLE[(CYCLE.indexOf(detail) + step + CYCLE.length) % CYCLE.length] ?? detail

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderPropsOf, ToolCallInput } from 'claude-code'

import type { CallRecord, DetailRun, LoopActivity, ToolDetail } from '../types'

const loops = atom({ plugin: 'spinner-tool-desc', key: 'loops' } as const, {})
const now = atom({ plugin: 'spinner-tool-desc', key: 'now' } as const, 0)
// Where a session starts until `/transcript-tool-detail` chooses.
const INITIAL_DETAIL: ToolDetail = 'none'
const toolDetail = atom({ plugin: 'spinner-tool-desc', key: 'detail' } as const, INITIAL_DETAIL)
// Bumped by each `/transcript-tool-detail`, so a row's earlier click lapses.
const epoch = atom({ plugin: 'spinner-tool-desc', key: 'epoch' } as const, 0)
// Families: one member per tool call, by its tool_use_id.
const CALLS = { plugin: 'spinner-tool-desc', key: 'calls' } as const
const VIEWS = { plugin: 'spinner-tool-desc', key: 'views' } as const

// Said in place of the engine's random spinner verb (`Sauteing`), by what the
// turn is doing.
const MODE_LABELS: Record<RenderPropsOf['Spinner']['mode'], string> = {
  requesting: 'Waiting for model',
  thinking: 'Thinking',
  responding: 'Responding',
  'tool-input': 'Preparing tool call',
  'tool-use': 'Running tool',
}

const EMPTY: LoopActivity = { running: [], last: null }
const MAX_LENGTH = 60
const PATH_ARGS = ['file_path', 'notebook_path']
const TEXT_ARGS = ['pattern', 'query', 'url', 'command', 'skill', 'prompt']

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH - 1)}…` : flat
}

const toolLabel = (tool: string) => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${mcp[1]}:${mcp[2]}` : tool
}

// The tool's own `description` when the model gave one (Bash, Agent, ...),
// else the tool's name with its most telling argument.
export const describe = (e: ToolCallInput): string => {
  const args = e as unknown as Record<string, unknown>
  const own = args.description
  if (typeof own === 'string' && own.trim() !== '') return oneLine(own)

  const label = toolLabel(e.tool)
  for (const key of PATH_ARGS) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') {
      return oneLine(`${label} ${value.split(/[\\/]/).pop() ?? value}`)
    }
  }
  for (const key of TEXT_ARGS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(`${label} ${value}`)
  }
  return label
}

export const formatElapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// A finished call's duration: tenths under ten seconds, else as elapsed.
export const formatDuration = (ms: number) =>
  ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatElapsed(ms)

// Lines added and removed by a file-changing call, from its stored result:
// Edit's and Write's patch, a new file's content, a notebook cell's sources.
export type DiffStats = { added: number; removed: number }

const lineCount = (text: string) => (text === '' ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length)

const patchStats = (hunks: { lines: string[] }[]): DiffStats => {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

// A line diff of two texts: their common ends trimmed, the middle by longest
// common subsequence while that stays small, else counted whole.
export const lineDiff = (before: string, after: string): DiffStats => {
  const a = before === '' ? [] : before.split(/\r?\n/)
  const b = after === '' ? [] : after.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > 1_000_000) return { added: midB.length, removed: midA.length }
  let row = new Array<number>(midB.length + 1).fill(0)
  for (const lineA of midA) {
    const nextRow = [0]
    midB.forEach((lineB, j) => {
      nextRow.push(lineA === lineB ? (row[j] ?? 0) + 1 : Math.max(row[j + 1] ?? 0, nextRow[j] ?? 0))
    })
    row = nextRow
  }
  const common = row[midB.length] ?? 0
  return { added: midB.length - common, removed: midA.length - common }
}

export const diffStats = (tool: string, output: unknown): DiffStats | undefined => {
  if (typeof output !== 'object' || output === null) return undefined
  const result = output as Record<string, unknown>
  if (result.staged === true || typeof result.error === 'string') return undefined
  const hunks = Array.isArray(result.structuredPatch) ? (result.structuredPatch as { lines: string[] }[]) : undefined

  if (tool === 'Edit' && hunks !== undefined) return patchStats(hunks)
  if (tool === 'Write') {
    if (hunks !== undefined && hunks.length > 0) return patchStats(hunks)
    if (result.type === 'create' && typeof result.content === 'string') {
      return { added: lineCount(result.content), removed: 0 }
    }
    return undefined
  }
  if (tool === 'NotebookEdit' && typeof result.new_source === 'string') {
    const before = typeof result.old_source === 'string' ? result.old_source : ''
    if (result.edit_mode === 'delete') return { added: 0, removed: lineCount(before) }
    return lineDiff(before, result.new_source)
  }
  return undefined
}

// `/transcript-tool-detail` sets how much of each tool call its transcript row
// draws: `none`, the summary line alone; `compact`, the engine's row with its
// input cut to 10 lines and its result to 5 (each multi-line string, and each
// run of strings, a patch hunk's lines or a list of files, ends in a line
// saying how much is left out); `input`, the row with no result; `full`, the
// engine's own row. The stored call and what the model read are untouched.
const STORE_KEY = 'toolDetail'
const INPUT_LINES = 10
const OUTPUT_LINES = 5

// In the order a click on a tool row's summary line steps through them, from
// the bare line up to the whole row; a right or ctrl click steps back.
const DETAILS: Record<ToolDetail, string> = {
  none: 'the summary line alone',
  compact: `inputs cut to ${INPUT_LINES} lines, outputs to ${OUTPUT_LINES}`,
  input: 'inputs and the summary line, no outputs',
  full: 'tool rows drawn in full',
}
const CYCLE = Object.keys(DETAILS) as ToolDetail[]
const ALIASES = new Map<string, ToolDetail>([
  ['partial', 'compact'],
  ['default', 'full'], // the name `full` had before `none` became the start
])

export const parseDetail = (text: string): ToolDetail | undefined => {
  const word = text.trim().toLowerCase()
  return CYCLE.find(detail => detail === word) ?? ALIASES.get(word)
}

const OPTIONS = CYCLE.join(' · ')
export const nextDetail = (detail: ToolDetail, step: 1 | -1 = 1): ToolDetail =>
  CYCLE[(CYCLE.indexOf(detail) + step + CYCLE.length) % CYCLE.length] ?? INITIAL_DETAIL

// The line is a `Client` where the surface draws one (it tells the buttons
// apart), else a chromeless Button that only steps forward.
const LINE_KEY = 'tool-detail'
const describeDetail = (detail: ToolDetail) => `Tool detail: ${detail} (${DETAILS[detail]}).`

export const compact = (value: unknown, max: number): unknown => {
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
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, max)]))
  }
  return value
}

// A row's detail: what a click on it chose since the last command, else the
// command's. A row reads its own member, so a click redraws that row alone.
const detailOf = async ($: EngineInterface, id: string): Promise<ToolDetail> => {
  const view = await read($, { ...VIEWS, id })
  return view !== undefined && view.epoch === (await read($, epoch)) ? view.detail : read($, toolDetail)
}

const stepRow = async ($: EngineInterface, id: string, step: 1 | -1) => {
  const detail = nextDetail(await detailOf($, id), step)
  const current = await read($, epoch)
  await update($, { ...VIEWS, id }, () => ({ detail, epoch: current }))
}

// The command's choice is every row's, the clicked ones' too.
const setDetail = async ($: EngineInterface, detail: ToolDetail) => {
  await update($, toolDetail, () => detail)
  await update($, epoch, n => n + 1)
  await $.store.set(STORE_KEY, detail)
}

// The stored choice, under its current name.
async function loadDetail($: EngineInterface): Promise<ToolDetail> {
  const stored = await $.store.get(STORE_KEY)
  const detail = typeof stored === 'string' ? parseDetail(stored) : undefined
  if (detail === undefined) return INITIAL_DETAIL
  if (stored !== detail) await $.store.set(STORE_KEY, detail)
  return detail
}

const needsTick = (activity: LoopActivity) => activity.running.length > 0 || activity.last !== null

// Ticks `now` once a second while some loop runs a tool or sits idle after
// one, so its spinner's times move; stops itself once none does. A reload
// cancels the timer along with this variable.
let ticker: { cancel: () => void } | undefined

async function tick($: EngineInterface) {
  const all = await read($, loops)
  if (!Object.values(all).some(needsTick)) {
    ticker?.cancel()
    ticker = undefined
    return
  }
  const t = await $.clock.now()
  await update($, now, () => t)
}

function ensureTicker($: EngineInterface) {
  ticker ??= $.clock.every(1000, () => void tick($))
}

function setLoop(
  $: EngineInterface,
  key: string,
  fn: (activity: LoopActivity) => LoopActivity | undefined,
) {
  return update($, loops, all => {
    const nextAll = { ...all }
    const changed = fn(all[key] ?? EMPTY)
    if (changed === undefined) delete nextAll[key]
    else nextAll[key] = changed
    return nextAll
  })
}

function setCall($: EngineInterface, id: string, record: CallRecord) {
  return update($, { ...CALLS, id }, () => record)
}

// The main loop's calls this turn, for the summary line that closes it.
type TurnStats = {
  tools: number
  failed: number
  slowest: { description: string; ms: number } | null
  diff?: DiffStats
}
const NO_STATS: TurnStats = { tools: 0, failed: 0, slowest: null }
let turnStats = NO_STATS

export const summarize = (stats: TurnStats): string | undefined => {
  if (stats.tools === 0) return undefined
  const parts = [`${stats.tools} tool${stats.tools === 1 ? '' : 's'}${stats.failed > 0 ? ` (${stats.failed} failed)` : ''}`]
  if (stats.diff !== undefined) parts.push(`+${stats.diff.added}/-${stats.diff.removed} lines`)
  if (stats.slowest !== null && stats.slowest.ms >= 1000) {
    parts.push(`slowest: ${stats.slowest.description} ${formatDuration(stats.slowest.ms)}`)
  }
  return parts.join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const detail = await loadDetail($)
    await update($, toolDetail, () => detail)
    await $.command.register({
      name: 'transcript-tool-detail',
      description: 'How much of each tool call the transcript shows: none, compact, input or full',
      argumentHint: `[${CYCLE.join('|')}]`,
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'transcript-tool-detail' }, async ($, e) => {
    if (e.args.trim() === '') return { text: `${describeDetail(await read($, toolDetail))}\nOptions: ${OPTIONS}` }
    const detail = parseDetail(e.args)
    if (detail === undefined) return { text: `Usage: /transcript-tool-detail [${CYCLE.join('|')}]` }
    await setDetail($, detail)
    return { text: describeDetail(detail) }
  })

  // A summary line's click, from its `Client`: `{ step: 1 }` or `{ step: -1 }`.
  on('ui.message', async ($, e, next) => {
    if (e.component !== 'ToolUse' || e.element !== LINE_KEY) return next(e)
    const step = (e.data as { step?: unknown } | null)?.step
    if (step === 1 || step === -1) await stepRow($, e.requestId, step)
    return {}
  })

  // A result below its row, and a running call's live output: cut in
  // `compact`, gone in `input` and `none`.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const detail = await detailOf($, e.requestId)
    if (detail === 'compact') return next({ ...e, props: { ...e.props, output: compact(e.props.output, OUTPUT_LINES) } })
    if (detail === 'full') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const detail = await detailOf($, e.requestId)
    if (detail !== 'input' && detail !== 'none') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('turn.start', async ($, e, next) => {
    turnStats = NO_STATS
    await setLoop($, 'main', () => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const key = e.agentId ?? 'main'
    const startedAt = await $.clock.now()
    const call = { id: e.tool_use_id, description: describe(e), startedAt }
    await setLoop($, key, a => ({ ...a, running: [...a.running, call] }))
    await setCall($, call.id, { description: call.description, startedAt, endedAt: null, isErrored: false })
    ensureTicker($)

    let isErrored = true
    let diff: DiffStats | undefined
    try {
      const ran = await next(e)
      isErrored = ran.deny !== undefined || ran.isError === true
      if (!isErrored) diff = diffStats(e.tool, ran.result)
      return ran
    } finally {
      const endedAt = await $.clock.now()
      await update($, now, () => endedAt)
      await setCall($, call.id, { description: call.description, startedAt, endedAt, isErrored })
      await setLoop($, key, a => ({
        running: a.running.filter(c => c.id !== call.id),
        last: { description: call.description, endedAt, isErrored },
      }))
      if (key === 'main') {
        const ms = endedAt - startedAt
        const { tools, failed, slowest, diff: turnDiff } = turnStats
        turnStats = {
          tools: tools + 1,
          failed: failed + (isErrored ? 1 : 0),
          slowest: slowest === null || ms > slowest.ms ? { description: call.description, ms } : slowest,
          diff:
            diff === undefined
              ? turnDiff
              : { added: (turnDiff?.added ?? 0) + diff.added, removed: (turnDiff?.removed ?? 0) + diff.removed },
        }
      }
      ensureTicker($)
    }
  }).catch(($, e, next) => next(e)) // a fault here only costs the spinner text, never the call

  on('turn.complete', async ($, e, next) => {
    await setLoop($, e.agentId ?? 'main', () => undefined)
    if (e.agentId === undefined) {
      const summary = summarize(turnStats)
      turnStats = NO_STATS
      if (summary !== undefined) $.ui.log(summary)
    }
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const all = await read($, loops)
    const activity = all[e.requestId] ?? all.main
    // The desktop's word is already the step's own description; the
    // terminal's is a random verb, replaced by what the turn is doing.
    const lead = e.props.message ?? (e.surface === 'terminal' ? MODE_LABELS[e.props.mode] : e.props.word)

    const current = activity?.running.at(-1)
    if (activity !== undefined && current !== undefined) {
      const others = activity.running.length - 1
      const what = others > 0 ? `${current.description} (+${others} more)` : current.description
      const elapsed = formatElapsed(Math.max(0, (await read($, now)) - current.startedAt))
      const message = `${what}${what.endsWith('…') ? '' : '…'} ${elapsed}`
      return next({ ...e, props: { ...e.props, message, suffix: '' } })
    }

    if (activity !== undefined && activity.last !== null) {
      const { description, endedAt, isErrored } = activity.last
      const elapsed = formatElapsed(Math.max(0, (await read($, now)) - endedAt))
      const message = `${lead}${lead.endsWith('…') ? '' : '…'} ${elapsed} since ${isErrored ? '✗ ' : ''}“${description}”`
      return next({ ...e, props: { ...e.props, message, suffix: '' } })
    }

    return next({ ...e, props: { ...e.props, message: lead } })
  })

  // A tool row in the transcript gets a line under it, in every detail and on
  // every surface, so a click can always step it: the call named as the
  // spinner did, the lines a file change added (green) and removed (red), how
  // long it took once that is a second or more, in the spinner's color (the
  // theme's `claude`), and a failure in red. In `none` that line is the row.
  on('ui.render', { component: 'ToolUse' }, async ($, raised, next) => {
    const detail = await detailOf($, raised.requestId)
    const e =
      detail === 'compact'
        ? {
            ...raised,
            props: {
              ...raised.props,
              input: compact(raised.props.input, INPUT_LINES),
              ...(raised.props.output !== undefined && { output: compact(raised.props.output, OUTPUT_LINES) }),
            },
          }
        : raised
    const record = await read($, memberOf(CALLS, e))
    const ms = record?.endedAt != null ? record.endedAt - record.startedAt : undefined
    const isErrored = e.props.isErrored || record?.isErrored === true
    const isFinished = !e.props.isRunning && !e.props.isInterrupted && ms !== undefined
    const failure = isFinished && isErrored ? `✗ failed after ${formatDuration(ms)}` : undefined
    const duration = isFinished && !isErrored && ms >= 1000 ? formatDuration(ms) : undefined
    // From the stored result, never `compact`'s cut one, so rows of a resumed
    // session count too.
    const isDone = !e.props.isRunning && !e.props.isInterrupted
    const diff = isDone && !isErrored ? diffStats(e.props.tool, raised.props.output) : undefined
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const cycle = () => stepRow($, e.requestId, 1)
    // Each part one segment, or several where it has colors of its own; runs
    // of the line's own color draw as one Text.
    type Segment = DetailRun
    const diffPart = (stats: DiffStats | undefined): Segment[] | undefined =>
      stats && [
        { text: `+${stats.added}`, color: 'green' },
        { text: '/', color: 'claude' },
        { text: `-${stats.removed}`, color: 'red' },
      ]
    const line = (parts: (string | Segment[] | undefined)[]) => {
      const present = parts.filter(part => part !== undefined)
      const segments: Segment[] = [{ text: '  ', color: 'claude' }]
      present.forEach((part, i) => {
        if (i > 0) segments.push({ text: ' · ', color: 'claude' })
        segments.push(...(typeof part === 'string' ? [{ text: part, color: 'claude' as const }] : part))
      })
      if (present.length > 0 && failure !== undefined) segments.push({ text: ' · ', color: 'claude' })
      if (failure !== undefined) segments.push({ text: failure, color: 'red' })
      const runs = segments.reduce<Segment[]>((merged, segment) => {
        const last = merged.at(-1)
        if (last !== undefined && last.color === 'claude' && segment.color === 'claude') last.text += segment.text
        else merged.push({ ...segment })
        return merged
      }, [])
      // Mobile's table answers `Client` too, but the surface refuses it.
      if ((e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in elements) {
        const { Client } = elements
        return <Client key={LINE_KEY} module="./detail-line.tsx" props={{ runs }} />
      }
      return (
        <Button key={LINE_KEY} plain onPress={cycle}>
          {runs.map((run, i) => (
            <Text key={String(i)} color={run.color}>
              {run.text}
            </Text>
          ))}
        </Button>
      )
    }

    const input = typeof e.props.input === 'object' && e.props.input !== null ? e.props.input : {}
    const what = describe({ ...input, tool: e.props.tool } as ToolCallInput)
    if (detail === 'none') {
      const status = e.props.isRunning ? 'running' : e.props.isInterrupted ? 'interrupted' : undefined
      return line([what, diffPart(diff), status, duration])
    }

    const drawn = await next(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {line([what, diffPart(diff), duration])}
      </Box>
    )
  })

  // The line closing a turn (`Baked for 3s`) samples a past-tense verb too.
  on('ui.render', { component: 'TurnDuration' }, ($, e, next) =>
    next({ ...e, props: { ...e.props, word: 'Worked' } }),
  )
}

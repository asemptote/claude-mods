import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, RenderPropsOf, Timer } from 'claude-code'

import type { Detail, LoopActivity, Run } from '../types'
import {
  DETAIL_OPTIONS,
  DETAILS,
  INPUT_LINES,
  OUTPUT_LINES,
  age,
  compact,
  describe,
  diffOf,
  firstLine,
  lineCount,
  numberCalls,
  parseDetail,
  stepDetail,
  took,
} from './format'

const loops = atom({ plugin: 'tool-status', key: 'loops' } as const, {})
const now = atom({ plugin: 'tool-status', key: 'now' } as const, 0)
// Where a session starts until `/tool-detail` chooses.
const INITIAL_DETAIL: Detail = 'none'
const detail = atom({ plugin: 'tool-status', key: 'detail' } as const, INITIAL_DETAIL)
const epoch = atom({ plugin: 'tool-status', key: 'epoch' } as const, 0)
// Families: one member per tool call, by its tool_use_id.
const VIEWS = { plugin: 'tool-status', key: 'views' } as const
const CALLS = { plugin: 'tool-status', key: 'calls' } as const

const MAIN = 'main'
const STORE_KEY = 'detail'
const LINE_KEY = 'tool-detail'
const EMPTY: LoopActivity = { running: [], last: null }

// Said in place of the terminal's random spinner verb (`Sauteing`), by what
// the turn is doing.
const MODE_LABELS: Record<RenderPropsOf['Spinner']['mode'], string> = {
  requesting: 'Waiting for model',
  thinking: 'Thinking',
  responding: 'Responding',
  'tool-input': 'Preparing tool call',
  'tool-use': 'Running tool',
}

const MISSING_DESCRIPTION =
  'Bash calls need a description: retry with a short description of what the command does, and give one on every Bash call.'

const isBackgrounded = (result: unknown) =>
  typeof result === 'object' && result !== null && typeof (result as { backgroundTaskId?: unknown }).backgroundTaskId === 'string'

// A row's detail: what a click on it chose since the last `/tool-detail`, else
// the command's. A row reads its own member, so a click redraws that row alone.
async function detailOf($: EngineInterface, id: string): Promise<Detail> {
  const view = await read($, { ...VIEWS, id })
  return view !== undefined && view.epoch === (await read($, epoch)) ? view.detail : read($, detail)
}

async function stepRow($: EngineInterface, id: string, step: 1 | -1) {
  const next = stepDetail(await detailOf($, id), step)
  const current = await read($, epoch)
  await update($, { ...VIEWS, id }, () => ({ detail: next, epoch: current }))
}

// The command's choice is every row's, the clicked ones' too, and outlives the session.
async function setDetail($: EngineInterface, chosen: Detail) {
  await update($, detail, () => chosen)
  await update($, epoch, n => n + 1)
  await $.store.set(STORE_KEY, chosen)
}

function setLoop($: EngineInterface, key: string, fn: (activity: LoopActivity) => LoopActivity | undefined) {
  return update($, loops, all => {
    const nextAll = { ...all }
    const changed = fn(all[key] ?? EMPTY)
    if (changed === undefined) delete nextAll[key]
    else nextAll[key] = changed
    return nextAll
  })
}

// Ticks `now` once a second while some loop runs a tool or sits idle after
// one, so spinners and running rows move; stops itself once none does. A
// reload cancels the timer along with this variable.
let ticker: Timer | undefined

async function tick($: EngineInterface) {
  const all = await read($, loops)
  if (!Object.values(all).some(a => a.running.length > 0 || a.last !== null)) {
    ticker?.cancel()
    ticker = undefined
    return
  }
  const t = await $.clock.now()
  await update($, now, () => t)
}

const ensureTicker = ($: EngineInterface) => {
  ticker ??= $.clock.every(1000, () => void tick($))
}

// The main loop's calls since the prompt, each numbered as it starts. A
// prompt counts from 1 only after an answered turn: one after an interruption
// goes on with the count, as does one sent mid-turn, which starts no turn.
let callCount = 0
let isAnswered = true

// Numbers for the calls this process did not see run (a resumed session's),
// read from the transcript again only for a row it has not been asked about:
// one chain, so the rows drawn together share one read.
let fromTranscript: Promise<Map<string, number>> = Promise.resolve(new Map())
const asked = new Set<string>()

function transcriptNumber($: EngineInterface, id: string): Promise<number | undefined> {
  if (!asked.has(id)) {
    asked.add(id)
    fromTranscript = fromTranscript.then(async known => {
      if (known.has(id)) return known
      try {
        return numberCalls(await $.session.messages()).numbers
      } catch {
        return known
      }
    })
  }
  return fromTranscript.then(known => known.get(id))
}

// Where the count stands at the transcript's end, so a reload or a resume
// goes on with it; unread, it starts over.
async function resumeCount($: EngineInterface) {
  try {
    const numbered = numberCalls(await $.session.messages())
    callCount = numbered.count
    isAnswered = numbered.isAnswered
    fromTranscript = Promise.resolve(numbered.numbers)
  } catch {
    // The transcript unread, the next prompt counts from 1.
  }
}

const SEPARATOR: Run = { text: ' · ', color: null, dim: true }
const dim = (text: string): Run => ({ text, color: null, dim: true })

// A row's line, which a click steps. A `Client` tells the buttons apart;
// mobile's table answers `Client` too, but the surface refuses it, so there
// and elsewhere a Button steps forward.
function lineOf($: EngineInterface, e: RenderInput, runs: Run[]) {
  const elements = $.ui.resolve(e)
  if ((e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in elements) {
    const { Client } = elements
    return <Client key={LINE_KEY} module="./line.tsx" props={{ runs }} />
  }
  const { Button, Text } = elements
  return (
    <Button key={LINE_KEY} plain onPress={() => stepRow($, e.requestId, 1)}>
      {runs.map((run, i) => (
        <Text key={String(i)} color={run.color ?? undefined} dimColor={run.dim}>
          {run.text}
        </Text>
      ))}
    </Button>
  )
}

export const register: Register = (on, options) => {
  const requireBashDescription = options.requireBashDescription === true
  const numberRows = options.numberRows === true

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    const chosen = (typeof stored === 'string' && parseDetail(stored)) || INITIAL_DETAIL
    await update($, detail, () => chosen)
    if (numberRows) await resumeCount($)
    await $.command.register({
      name: 'tool-detail',
      description: 'How much of each tool call the transcript shows: none, compact, input or full; the next one without an argument',
      argumentHint: `[${DETAIL_OPTIONS}]`,
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'tool-detail' }, async ($, e) => {
    const args = e.args.trim()
    const chosen = args === '' ? stepDetail(await read($, detail), 1) : parseDetail(args)
    if (chosen === undefined) return { text: `Usage: /tool-detail [${DETAIL_OPTIONS}]` }
    await setDetail($, chosen)
    return { text: `Tool detail: ${chosen} (${DETAILS[chosen]}).` }
  })

  // A line's click, from its `Client`: `{ step: 1 }` or `{ step: -1 }`.
  on('ui.message', async ($, e, next) => {
    if (e.element !== LINE_KEY) return next(e)
    const step = (e.data as { step?: unknown } | null)?.step
    if (step === 1 || step === -1) await stepRow($, e.requestId, step)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '' && isAnswered) callCount = 0
    await setLoop($, e.agentId ?? MAIN, () => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Numbered first, so parallel calls take theirs in the order they were
    // made, and a refused call, whose row is drawn too, takes one.
    const n = e.agentId === undefined ? ++callCount : undefined
    const own = (e as { description?: unknown }).description
    if (requireBashDescription && e.tool === 'Bash' && (typeof own !== 'string' || own.trim() === '')) {
      return { deny: MISSING_DESCRIPTION }
    }

    const key = e.agentId ?? MAIN
    const id = e.tool_use_id
    const { label, detail: what = null } = describe(e.tool, e)
    const startedAt = await $.clock.now()
    await setLoop($, key, a => ({ ...a, running: [...a.running, { id, label, detail: what, startedAt }] }))
    const numbered = n === undefined ? {} : { n }
    await update($, { ...CALLS, id }, () => ({ startedAt, endedAt: null, ...numbered }))
    ensureTicker($)

    let isErrored = true
    let backgrounded = false
    try {
      const ran = await next(e)
      isErrored = ran.deny !== undefined || ran.isError === true
      backgrounded = isBackgrounded(ran.result)
      return ran
    } finally {
      const endedAt = await $.clock.now()
      const ms = endedAt - startedAt
      await update($, now, () => endedAt)
      await update($, { ...CALLS, id }, () => ({ startedAt, endedAt, ...numbered }))
      // One write makes the call the idle line as it leaves the running list,
      // so the spinner never names the call before it in between.
      await setLoop($, key, a => ({
        running: a.running.filter(c => c.id !== id),
        last: { label, detail: what, endedAt, ms, isErrored, isBackgrounded: backgrounded },
      }))
    }
  })
    // A fault here must never cost the call, nor leave it on the spinner.
    .catch(async ($, e, next) => {
      await setLoop($, e.agentId ?? MAIN, a => ({ ...a, running: a.running.filter(c => c.id !== e.tool_use_id) }))
      return next(e)
    })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) isAnswered = !e.isAborted
    await setLoop($, e.agentId ?? MAIN, () => undefined)
    return next(e)
  })

  // The spinner names the newest running call's tool and its time, with what
  // it is doing whole on the line under it; while none runs, what the turn is
  // doing and how long since the last call ended.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const all = await read($, loops)
    const activity = all[e.requestId] ?? all[MAIN]
    const under = async (message: string, what: string | null) => {
      const line = await next({ ...e, props: { ...e.props, message, suffix: '' } })
      if (what === null) return line
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {line}
          <Box paddingLeft={2}>
            <Text bold color="claude">
              {what}
            </Text>
          </Box>
        </Box>
      )
    }

    const current = activity?.running.at(-1)
    if (activity !== undefined && current !== undefined) {
      const others = activity.running.length - 1
      const elapsed = age((await read($, now)) - current.startedAt)
      return under(`${current.label} ${elapsed}${others > 0 ? ` (+${others} more)` : ''}`, current.detail)
    }

    // A state the engine names (compacting, a retry) outranks the idle line.
    if (e.props.message !== null) return next(e)
    // The desktop's word is already the step's own description.
    const lead = e.surface === 'terminal' ? MODE_LABELS[e.props.mode] : e.props.word
    const last = activity?.last
    if (last == null) return next({ ...e, props: { ...e.props, message: lead } })
    const since = age((await read($, now)) - last.endedAt)
    const how = [took(last.ms), ...(last.isBackgrounded ? ['backgrounded'] : [])].join(', ')
    const ellipsis = lead.endsWith('…') ? '' : '…'
    return under(`${lead}${ellipsis} ${since} since ${last.isErrored ? '✗ ' : ''}${last.label} (${how})`, last.detail)
  })

  // Every tool row gets a line under it, in every detail and on every surface,
  // so a click can always step it: the call named as the spinner did, the
  // lines a file change added and removed, its time (counting while it runs),
  // and a failure in red. In `none` that line is the row, ctrl+o included,
  // where it opens with the call's place since the prompt.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output, isRunning, isErrored, isInterrupted } = e.props
    const shown = await detailOf($, e.requestId)
    const record = await read($, { ...CALLS, id: e.requestId })
    const ms = record?.endedAt != null ? record.endedAt - record.startedAt : undefined
    // From the stored result, so rows of a resumed session count too.
    const diff = !isRunning && !isInterrupted && !isErrored ? diffOf(output) : undefined
    const n = numberRows && e.props.isExpanded === true ? (record?.n ?? (await transcriptNumber($, e.requestId))) : undefined

    const name = describe(tool, input).text
    const parts: Run[][] = [
      n === undefined
        ? [{ text: `  ${name}`, color: 'claude', dim: false }]
        : [dim(`  ${n}. `), { text: name, color: 'claude', dim: false }],
    ]
    if (diff !== undefined) {
      parts.push([
        { text: `+${diff.added}`, color: 'success', dim: false },
        dim('/'),
        { text: `-${diff.removed}`, color: 'error', dim: false },
      ])
    }
    if (isRunning) parts.push([dim(record ? age((await read($, now)) - record.startedAt) : 'running')])
    else if (isInterrupted) {
      if (shown === 'none') parts.push([dim('interrupted')])
    } else if (isErrored) {
      parts.push([{ text: ms === undefined ? '✗ failed' : `✗ failed after ${took(ms)}`, color: 'error', dim: false }])
    } else if (ms !== undefined && ms >= 1000) parts.push([dim(took(ms))])
    if (isBackgrounded(output)) parts.push([dim('backgrounded')])
    const runs = parts.flatMap((part, i) => (i === 0 ? part : [SEPARATOR, ...part]))

    const line = lineOf($, e, runs)
    if (shown === 'none') return line

    const { output: _output, ...withoutOutput } = e.props
    const props =
      shown === 'compact'
        ? {
            ...e.props,
            input: compact(input, INPUT_LINES),
            ...(output !== undefined && { output: compact(output, OUTPUT_LINES) }),
          }
        : shown === 'input'
          ? withoutOutput
          : e.props
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next({ ...e, props })}
        {line}
      </Box>
    )
  })

  // A message another party sent (an agent, a teammate, a session, a channel)
  // folds in ctrl+o as a tool row does, to a line naming the sender with the
  // message's first line; `compact` cuts the body, `input` and `full` show it
  // whole. The main view draws its own one line.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { text, from, isExpanded } = e.props
    if (!isExpanded || from === undefined) return next(e)
    const shown = await detailOf($, e.requestId)
    const count = lineCount(text)
    const runs: Run[] = [{ text: `  ${from.name}: ${firstLine(text) ?? ''}`, color: 'claude', dim: false }]
    if (count > 1) runs.push(SEPARATOR, dim(`${count} lines`))
    const line = lineOf($, e, runs)
    if (shown === 'none') return line
    const props = shown === 'compact' ? { ...e.props, text: compact(text, INPUT_LINES) as string } : e.props
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next({ ...e, props })}
        {line}
      </Box>
    )
  })

  // The result under a row: cut in `compact`, gone in `input` and `none`.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const shown = await detailOf($, e.requestId)
    if (shown === 'full') return next(e)
    if (shown === 'compact') return next({ ...e, props: { ...e.props, output: compact(e.props.output, OUTPUT_LINES) } })
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // The line closing a turn (`Baked for 3s`) samples a random verb too.
  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => next({ ...e, props: { ...e.props, word: 'Worked' } }))
}

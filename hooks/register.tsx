import { atom, memberOf, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, TextProps } from 'claude-code'

import type { Choice, Detail, Shown } from '../types'
import type { Segment } from './description'

const shown = atom({ plugin: 'spinner-detail', key: 'shown' } as const, null as Shown)
const lines = atom({ plugin: 'spinner-detail', key: 'lines' } as const, '')
const detail = atom({ plugin: 'spinner-detail', key: 'detail' } as const, 'none' as Detail)
const generation = atom({ plugin: 'spinner-detail', key: 'generation' } as const, 0)
const chosen = atom({ plugin: 'spinner-detail', key: 'chosen' } as const, null as Choice)

const TICK_MS = 500
const DETAIL_GRACE_MS = 5000
const INPUT_PREVIEW_LINES = 10
const OUTPUT_PREVIEW_LINES = 5
const DETAILS: readonly Detail[] = ['none', 'input-only', 'preview', 'full']
const DETAIL_DESCRIPTIONS: Record<Detail, string> = {
  preview: `Tool calls show the first ${INPUT_PREVIEW_LINES} input lines and ${OUTPUT_PREVIEW_LINES} output lines.`,
  full: 'Tool calls are shown in full.',
  'input-only': `Tool calls show the first ${INPUT_PREVIEW_LINES} input lines and no output.`,
  none: 'Tool calls show only their descriptions.',
}
const MISSING_DESCRIPTION =
  'Bash calls need a description: retry with a short description of what the command does, and give one on every Bash call.'

type Call = {
  id: string
  label: string
  detailAtCall: string | undefined
  startedAt: number
  finishedAt: number | null
  followedAt: number | null
  backgrounded: boolean
}

let latest: Call | null = null
let statePath: string | undefined
let published = ''

const jobStatePath = async ($: EngineInterface) => {
  const jobDirectory = await $.env.get('CLAUDE_JOB_DIR')
  if (jobDirectory) return `${jobDirectory}/state.json`
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/jobs/${(await $.session.id()).slice(0, 8)}/state.json` : undefined
}

const readJob = async ($: EngineInterface, path: string) => {
  try {
    const { state, detail } = JSON.parse(await $.fs.read(path))
    return { isWorking: state === 'working', detail: typeof detail === 'string' ? detail : '' }
  } catch {
    return undefined
  }
}

const formatElapsed = (seconds: number) => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

const formatDuration = (milliseconds: number) =>
  milliseconds < 10000 ? `${(milliseconds / 1000).toFixed(1)}s` : formatElapsed(Math.floor(milliseconds / 1000))

const settled = (call: Call, now?: number) =>
  call.finishedAt === null
    ? call.label
    : `${call.label} (${[
        formatDuration(call.finishedAt - call.startedAt),
        ...(call.followedAt !== null
          ? [`then ${formatDuration(call.followedAt - call.finishedAt)}`]
          : now === undefined
            ? []
            : [`${formatElapsed(Math.floor((now - call.finishedAt) / 1000))} ago`]),
        ...(call.backgrounded ? ['backgrounded'] : []),
      ].join(', ')})`

const follow = (call: Call | null, at: number) => {
  if (call && call.finishedAt !== null && call.followedAt === null) call.followedAt = at
}

const previewLines = (text: string, limit: number) => {
  const textLines = text.split('\n')
  const hiddenCount = textLines.length - limit
  return text && hiddenCount > 0 ? [...textLines.slice(0, limit), `... +${hiddenCount} lines`].join('\n') : text
}

const previewValue = (value: unknown, limit: number) => {
  let remaining = limit
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (!node.includes('\n')) return node
      const preview = previewLines(node, remaining)
      remaining = Math.max(0, remaining - node.split('\n').length)
      return preview
    }
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node === 'object' && node !== null)
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]))
    return node
  }
  return walk(value)
}

const diffCounts = (output: unknown) => {
  if (typeof output !== 'object' || output === null || !('structuredPatch' in output) || !Array.isArray(output.structuredPatch))
    return undefined
  const patchLines: unknown[] = output.structuredPatch.flatMap(hunk => (Array.isArray(hunk?.lines) ? hunk.lines : []))
  if (!patchLines.length && 'type' in output && output.type === 'create' && 'content' in output && typeof output.content === 'string')
    return { additions: output.content ? output.content.replace(/\n$/, '').split('\n').length : 0, deletions: 0 }
  const countPrefixed = (prefix: string) =>
    patchLines.filter(patchLine => typeof patchLine === 'string' && patchLine.startsWith(prefix)).length
  return { additions: countPrefixed('+'), deletions: countPrefixed('-') }
}

const diffSegments = (isErrored: boolean, output: unknown): Segment[] => {
  const counts = isErrored ? undefined : diffCounts(output)
  return counts
    ? [
        { text: `+${counts.additions}`, color: 'diffAdded' },
        { text: '/', color: null },
        { text: `-${counts.deletions}`, color: 'diffRemoved' },
      ]
    : []
}

const drawSegments = (Text: ElementConstructor<TextProps>, segments: Segment[]) =>
  segments.map(segment => <Text color={segment.color ?? undefined}>{segment.text}</Text>)

const isBackgrounded = (result: unknown) =>
  typeof result === 'object' && result !== null && 'backgroundTaskId' in result && result.backgroundTaskId !== undefined

const isDetail = (text: string): text is Detail => DETAILS.some(known => known === text)

const stepDetail = (current: Detail, step: number) =>
  DETAILS[(DETAILS.indexOf(current) + step + DETAILS.length) % DETAILS.length] ?? current

type Row = { requestId: string }

const detailOf = async ($: EngineInterface, row: Row) => {
  const choice = await read($, memberOf(chosen, row))
  return choice && choice.generation === (await read($, generation)) ? choice.detail : read($, detail)
}

const cycleRow = async ($: EngineInterface, row: Row, step: number) => {
  const choice = { detail: stepDetail(await detailOf($, row), step), generation: await read($, generation) }
  await update($, memberOf(chosen, row), () => choice)
}

const chooseAll = async ($: EngineInterface, choose: (current: Detail) => Detail) => {
  await update($, generation, current => current + 1)
  return update($, detail, choose)
}

const publish = async ($: EngineInterface, now: number) => {
  const message = latest && settled(latest, now)
  const key = JSON.stringify([latest?.id, message])
  if (key === published) return
  published = key
  await update($, shown, () => message)
  if (latest && message) await update($, memberOf(lines, { requestId: latest.id }), () => message)
}

const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const call = latest
  if (call && statePath && (call.finishedAt === null || now - call.finishedAt < DETAIL_GRACE_MS)) {
    const job = await readJob($, statePath)
    if (job?.isWorking && job.detail && job.detail !== call.detailAtCall) call.label = job.detail
  }
  await publish($, now)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    statePath = await jobStatePath($)
    $.clock.every(TICK_MS, () => void tick($))
    await $.command.register({
      name: 'tool-detail',
      description: `Show tool calls previewed, as input only, as descriptions only or in full; cycles without an argument`,
      argumentHint: DETAILS.join('|'),
      immediate: true,
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const description = 'description' in e && typeof e.description === 'string' ? e.description.trim() : ''
    if (e.tool === 'Bash' && !description) return { deny: MISSING_DESCRIPTION }
    const job = statePath ? await readJob($, statePath) : undefined
    const previous = latest
    const startedAt = await $.clock.now()
    const call: Call = {
      id: e.tool_use_id,
      label: description || e.tool,
      detailAtCall: job?.detail,
      startedAt,
      finishedAt: null,
      followedAt: null,
      backgrounded: false,
    }
    follow(previous, startedAt)
    latest = call
    if (previous) await update($, memberOf(lines, { requestId: previous.id }), () => settled(previous))
    await publish($, startedAt)

    try {
      const outcome = await next(e)
      call.backgrounded = isBackgrounded(outcome.result)
      return outcome
    } finally {
      call.finishedAt = await $.clock.now()
      if (latest === call) await publish($, call.finishedAt)
      else await update($, memberOf(lines, { requestId: call.id }), () => settled(call))
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      follow(latest, now)
      await publish($, now)
    }
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const message = await read($, shown)
    return message === null ? next(e) : next({ ...e, props: { ...e.props, message } })
  })

  on('command.run', { command: 'tool-detail' }, async ($, e) => {
    const requested = e.args.trim()
    if (requested && !isDetail(requested)) return { text: `Unknown tool detail "${requested}": use one of ${DETAILS.join(', ')}.` }
    const shownDetail = await chooseAll($, current => (requested && isDetail(requested) ? requested : stepDetail(current, 1)))
    return { text: DETAIL_DESCRIPTIONS[shownDetail] }
  })

  on('ui.message', { component: 'ToolUse' }, async ($, e, next) => {
    const isBackward = typeof e.data === 'object' && e.data !== null && 'step' in e.data && e.data.step === -1
    await cycleRow($, e, isBackward ? -1 : 1)
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const line = await read($, memberOf(lines, e))
    const shownDetail = await detailOf($, e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { Client } = e.surface === 'terminal' || e.surface === 'desktop' ? $.ui.resolve(e) : { Client: undefined }
    const counts = diffSegments(e.props.isErrored, e.props.output)
    const segments: Segment[] = [
      { text: `  ${line}`, color: e.props.isErrored ? 'error' : 'claude' },
      ...(counts.length ? [{ text: ' ', color: null }, ...counts] : []),
    ]
    const key = `detail-${e.props.tool_use_id}`
    const description =
      line &&
      (Client ? (
        <Client key={key} module="./description.tsx" props={{ segments }} />
      ) : (
        <Button key={key} plain onPress={() => void cycleRow($, e, 1)}>
          {drawSegments(Text, segments)}
        </Button>
      ))
    if (shownDetail === 'none' && description) return description
    const { output, ...withoutOutput } = e.props
    const input = previewValue(e.props.input, INPUT_PREVIEW_LINES)
    const row = await next(
      shownDetail === 'full'
        ? e
        : shownDetail === 'preview'
          ? { ...e, props: { ...e.props, input, output: previewValue(output, OUTPUT_PREVIEW_LINES) } }
          : { ...e, props: { ...withoutOutput, input } },
    )
    if (!description) return row
    return (
      <Box flexDirection="column">
        {row}
        {description}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const shownDetail = await detailOf($, e)
    if (shownDetail === 'full') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (shownDetail !== 'preview') return <Box />
    const counts = diffSegments(e.props.isErrored, e.props.output)
    if (counts.length)
      return (await read($, memberOf(lines, e))) ? (
        <Box />
      ) : (
        <Box flexDirection="row">
          <Text>{'     '}</Text>
          {drawSegments(Text, counts)}
        </Box>
      )
    if (!e.props.isErrored || typeof e.props.output !== 'string')
      return next({ ...e, props: { ...e.props, output: previewValue(e.props.output, OUTPUT_PREVIEW_LINES) } })
    const errorLines = previewLines(e.props.output.trim(), OUTPUT_PREVIEW_LINES).split('\n')
    return (
      <Box flexDirection="column">
        {errorLines.map(errorLine => (
          <Text color="error">{`     ${errorLine}`}</Text>
        ))}
      </Box>
    )
  })
}

import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MountTarget } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  compact,
  describe,
  diffStats,
  formatDuration,
  formatElapsed,
  lineDiff,
  nextDetail,
  summarize,
} from '../hooks/register'

const SPINNER = {
  plugin: 'spinner-tool-desc',
  surface: 'terminal',
  component: 'Spinner',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
} as const

const toolRow = (id: string, tool: string, input: unknown, isErrored = false, output?: unknown) =>
  ({
    plugin: 'spinner-tool-desc',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool, input, isRunning: false, isErrored, isInterrupted: false, output },
  }) as const

const BASH = { tool: 'Bash', command: 'npm test', description: 'Run tests' } as const

// The engine beneath the mod: a tool that answers when the gate opens (or
// fails, for `fails`), plain drawings of the spinner and tool rows, and a
// store holding `full`, read once `$.session.start` runs.
function engine(on: On, { fails = false } = {}) {
  mock.store(on, { toolDetail: 'full' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  on('tool.call', async () => {
    await gate
    return fails ? { deny: 'failed in test' } : { result: { stdout: 'ok' } as never }
  })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.message ?? e.props.word}${e.props.suffix}`}</Text>
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.tool}(…)`}</Text>
  })
  return { release }
}

async function textsOf($: Engine, target: MountTarget) {
  const ui = await $.ui.mount(target)
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  // A summary line drawn by its `Client`, last in the row.
  for (const client of await ui.findAll({ type: 'Client' })) {
    texts.push(...(await ui.findAll({ type: 'Text', in: client.key })).map(found => found.text))
  }
  await ui.unmount()
  return texts
}

test('describes a call by its description, else its tool and argument', () => {
  expect(describe({ tool: 'Bash', tool_use_id: 'a', command: 'npm test', description: 'Run tests' } as never)).toBe('Run tests')
  expect(describe({ tool: 'Read', tool_use_id: 'b', file_path: 'C:\\src\\app.ts' } as never)).toBe('Read app.ts')
  expect(describe({ tool: 'mcp__gh__search', tool_use_id: 'c', query: 'bugs' } as never)).toBe('gh:search bugs')
  expect(formatElapsed(64_000)).toBe('1m 4s')
  expect(formatDuration(2_500)).toBe('2.5s')
  expect(formatDuration(38_000)).toBe('38s')
})

test('spinner counts the running tool up, then the time since it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const tool = engine(on)

  expect(await textsOf($, SPINNER)).toEqual(['Thinking…'])

  const call = $.tool.call({ ...BASH, tool_use_id: 't1' })
  await clock.settle()
  expect(await textsOf($, SPINNER)).toEqual(['Run tests… 0s'])
  await clock.advance(5_000)
  expect(await textsOf($, SPINNER)).toEqual(['Run tests… 5s'])

  tool.release()
  await call
  await clock.advance(12_000)
  expect(await textsOf($, SPINNER)).toEqual(['Thinking… 12s since “Run tests”'])

  // The finished row: its description and how long it took.
  expect(await textsOf($, toolRow('t1', 'Bash', BASH))).toContain('  Run tests · 5.0s')
})

test('a failed call is marked in the spinner and in red on its row', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const tool = engine(on, { fails: true })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })

  const call = $.tool.call({ ...BASH, tool_use_id: 't2' })
  await clock.advance(3_000)
  tool.release()
  await call

  expect(await textsOf($, SPINNER)).toEqual(['Thinking… 0s since ✗ “Run tests”'])
  const row = await textsOf($, toolRow('t2', 'Bash', BASH, true))
  expect(row).toEqual(['Bash(…)', '  Run tests · ', '✗ failed after 3.0s'])
  // the failure is its own, red, Text
})

test('every row keeps its line, naming the call as the spinner did, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const tool = engine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  tool.release()

  // A quick call with no description of its own, and no duration to show.
  await $.tool.call({ tool: 'Read', tool_use_id: 'quick', file_path: 'a.ts' })
  const read = toolRow('quick', 'Read', { file_path: 'a.ts' })
  expect(await textsOf($, read)).toEqual(['Read(…)', '  Read a.ts'])
  expect(await textsOf($, { ...read, surface: 'desktop' })).toEqual(['Read(…)', '  Read a.ts'])

  const agent = { tool: 'Agent', description: 'Explore', prompt: 'x' } as const
  expect(await textsOf($, toolRow('never-ran', 'Agent', agent))).toEqual(['Agent(…)', '  Explore'])
  await clock.settle()
})

test('the turn closes with a summary line, and its footer says Worked', async ($, on) => {
  expect(summarize({ tools: 0, failed: 0, slowest: null })).toBeUndefined()
  expect(summarize({ tools: 14, failed: 1, slowest: { description: 'Run tests', ms: 38_000 } })).toBe(
    '14 tools (1 failed) · slowest: Run tests 38s',
  )
  expect(summarize({ tools: 1, failed: 0, slowest: { description: 'Read a.ts', ms: 20 } })).toBe('1 tool')

  const clock = mock.clock(on, { now: 0 })
  const tool = engine(on)
  const logged: string[] = []
  on('ui.log', (_$, e) => {
    logged.push(e.text)
    return { value: undefined } as never
  })
  on('ui.render', { component: 'TurnDuration' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.word} for ${e.props.durationMs / 1000}s`}</Text>
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'go', turnId: 'turn' })
  const call = $.tool.call({ ...BASH, tool_use_id: 't3' })
  await clock.advance(2_000)
  tool.release()
  await call
  await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 'turn', reason: 'answer' })
  expect(logged).toEqual(['1 tool · slowest: Run tests 2.0s'])

  const footer = { plugin: 'spinner-tool-desc', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 3000 } } as const
  expect(await textsOf($, footer)).toEqual(['Worked for 3s'])
})

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n')

test('compact cuts multi-line strings and runs of strings, leaving the rest', () => {
  expect(compact(lines(10), 10)).toBe(lines(10))
  expect(compact(lines(12), 10)).toBe(`${lines(9)}\n… +3 lines`)
  expect(compact({ stdout: lines(8), stderr: '', interrupted: false, code: 0 }, 5)).toEqual({
    stdout: `${lines(4)}\n… +4 lines`,
    stderr: '',
    interrupted: false,
    code: 0,
  })
  const hunk = { oldStart: 1, lines: ['-a', '+b', ' c', ' d', ' e', ' f', ' g'] }
  expect(compact([hunk], 5)).toEqual([{ oldStart: 1, lines: ['-a', '+b', ' c', ' d', ' … +3 more'] }])
})

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const toolDetail = ($: Engine, args: string) => $.command.run({ command: 'transcript-tool-detail', args, ...RUN })

// An engine that draws a row as its command, a result as its stdout, and live
// output as `live`; and the rows a 15-line command with 9 lines of output draws.
function detailEngine(on: On, stored: Record<string, unknown>) {
  mock.store(on, stored)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{(e.props.input as { command: string }).command}</Text>
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{(e.props.output as { stdout: string }).stdout}</Text>
  })
  on('ui.render', { component: 'ToolProgress' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>live</Text>
  })
}

const BIG = { command: lines(15, 'cmd'), description: 'Build it' }
const row = toolRow('c1', 'Bash', BIG)
const result = {
  plugin: 'spinner-tool-desc',
  surface: 'terminal',
  component: 'ToolResult',
  requestId: 'c1',
  props: { tool_use_id: 'c1', tool: 'Bash', output: { stdout: lines(9, 'out') }, isErrored: false },
} as const
const progress = { plugin: 'spinner-tool-desc', surface: 'terminal', component: 'ToolProgress', requestId: 'c1', props: {} } as never

async function rowsOf($: Engine) {
  return { row: await textsOf($, row), result: await textsOf($, result), progress: await textsOf($, progress) }
}

test('/transcript-tool-detail draws none, compact, input and full rows, kept across sessions', async ($, on) => {
  detailEngine(on, {})
  const start = () => $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await start()

  // A session with nothing stored starts at the summary line alone.
  expect((await toolDetail($, '')).text).toBe(
    'Tool detail: none (the summary line alone).\nOptions: none · compact · input · full',
  )
  expect((await toolDetail($, 'full')).text).toContain('Tool detail: full')
  expect(await rowsOf($)).toEqual({
    row: [lines(15, 'cmd'), '  Build it'],
    result: [lines(9, 'out')],
    progress: ['live'],
  })

  expect((await toolDetail($, 'partial')).text).toContain('Tool detail: compact')
  expect(await rowsOf($)).toEqual({
    row: [`${lines(9, 'cmd')}\n… +6 lines`, '  Build it'],
    result: [`${lines(4, 'out')}\n… +5 lines`],
    progress: ['live'],
  })

  expect((await toolDetail($, 'input')).text).toContain('Tool detail: input')
  expect(await rowsOf($)).toEqual({ row: [lines(15, 'cmd'), '  Build it'], result: [], progress: [] })

  expect((await toolDetail($, 'none')).text).toContain('Tool detail: none')
  expect(await rowsOf($)).toEqual({ row: ['  Build it'], result: [], progress: [] })

  // The choice outlives the session.
  await start()
  expect((await rowsOf($)).row).toEqual(['  Build it'])
  expect((await toolDetail($, 'maybe')).text).toBe('Usage: /transcript-tool-detail [none|compact|input|full]')
})

test('none names a call with no description by its tool and argument', async ($, on) => {
  detailEngine(on, { toolDetail: 'none' })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect(await textsOf($, toolRow('r1', 'Read', { file_path: '/src/app.ts' }))).toEqual(['  Read app.ts'])
})

test("a stored `default`, full's old name, reads as full", async ($, on) => {
  detailEngine(on, { toolDetail: 'default' })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect((await toolDetail($, '')).text).toContain('Tool detail: full')
})

test("a click on a row's summary line steps that row's detail: left forward, right or ctrl+left back", async ($, on) => {
  expect(['none', 'compact', 'input', 'full'].map(d => nextDetail(d as never))).toEqual([
    'compact',
    'input',
    'full',
    'none',
  ])
  expect(['none', 'compact', 'input', 'full'].map(d => nextDetail(d as never, -1))).toEqual([
    'full',
    'none',
    'compact',
    'input',
  ])
  detailEngine(on, {})
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect((await toolDetail($, '')).text).toContain('Tool detail: none')

  const ui = await $.ui.mount(row)
  const drawn = async () => [
    ...(await ui.findAll({ type: 'Text' })).map(found => found.text),
    ...(await ui.findAll({ type: 'Text', in: 'tool-detail' })).map(found => found.text),
  ]
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect((await ui.find({ type: 'Client' }))?.key).toBe('tool-detail')
  expect(await drawn()).toEqual(['  Build it'])

  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left' })
  expect(await drawn()).toEqual([`${lines(9, 'cmd')}\n… +6 lines`, '  Build it'])
  expect(await textsOf($, result)).toEqual([`${lines(4, 'out')}\n… +5 lines`])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left' })
  expect(await drawn()).toEqual([lines(15, 'cmd'), '  Build it'])
  expect(await textsOf($, result)).toEqual([])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'right' })
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'right' })
  expect(await drawn()).toEqual(['  Build it'])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', ctrl: true })
  expect(await drawn()).toEqual([lines(15, 'cmd'), '  Build it'])
  expect(await textsOf($, result)).toEqual([lines(9, 'out')])
  // A middle click, and the button coming up, step nothing.
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'middle' })
  await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left' })
  expect(await textsOf($, result)).toEqual([lines(9, 'out')])

  // Only the clicked row changed; the command's choice is every row's again.
  expect(await textsOf($, toolRow('c2', 'Bash', BIG))).toEqual(['  Build it'])
  expect((await toolDetail($, '')).text).toContain('Tool detail: none')
  await toolDetail($, 'compact')
  expect(await drawn()).toEqual([`${lines(9, 'cmd')}\n… +6 lines`, '  Build it'])
  await ui.unmount()

  // Inverted while the pointer is over it.
  await toolDetail($, 'none')
  const hover = await $.ui.mount(row)
  const inverted = async () =>
    (await hover.findAll({ type: 'Text', in: 'tool-detail' })).map(found => found.props.inverse === true)
  expect(await inverted()).toEqual([false])
  await hover.pointer({ type: 'enter', x: 2, y: 0 })
  expect(await inverted()).toEqual([true])
  await hover.pointer({ type: 'leave', x: 2, y: 0 })
  expect(await inverted()).toEqual([false])
  await hover.unmount()

  // The desktop draws the line in `none` alone, so one click there.
  const desktop = await $.ui.mount({ ...row, surface: 'desktop' })
  await desktop.pointer({ type: 'down', x: 2, y: 0, button: 'left' })
  expect(await textsOf($, result)).toEqual([`${lines(4, 'out')}\n… +5 lines`])
  expect((await toolDetail($, '')).text).toContain('Tool detail: none')
  await desktop.unmount()
})

test('where no Client is drawn the line is a Button that steps its row forward', async ($, on) => {
  detailEngine(on, { toolDetail: 'none' })
  await $.session.start({ cwd: '.', surface: 'mobile', isInteractive: true })
  const ui = await $.ui.mount({ ...row, surface: 'mobile' })
  const button = await ui.find({ type: 'Button' })
  expect(button?.props).toMatchObject({ key: 'tool-detail' })
  expect(button?.props.action).toBeUndefined()

  await ui.press({ key: 'tool-detail' })
  expect(await textsOf($, row)).toEqual([`${lines(9, 'cmd')}\n… +6 lines`, '  Build it'])
  expect((await toolDetail($, '')).text).toContain('Tool detail: none')
  await ui.unmount()
})

// An edit whose patch runs past compact's 5 lines: 4 added, 2 removed.
const EDIT_RESULT = {
  filePath: 'a.ts',
  oldString: 'a\nb',
  newString: 'c\nd\ne\nf',
  originalFile: 'a\nb\ng',
  structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, lines: ['-a', '-b', '+c', '+d', '+e', '+f', ' g'] }],
  userModified: false,
  replaceAll: false,
}

test('counts the lines a file change added and removed', () => {
  expect(diffStats('Edit', EDIT_RESULT)).toEqual({ added: 4, removed: 2 })
  expect(diffStats('Edit', { ...EDIT_RESULT, staged: true })).toBeUndefined()
  expect(diffStats('Write', { type: 'create', filePath: 'b.ts', content: 'a\nb\nc\n', structuredPatch: [], originalFile: null })).toEqual({ added: 3, removed: 0 })
  expect(diffStats('Write', { type: 'update', filePath: 'b.ts', content: '', structuredPatch: [], originalFile: null })).toBeUndefined()
  expect(diffStats('NotebookEdit', { new_source: 'a\nB\nc\nd', old_source: 'a\nb\nc', edit_mode: 'replace', cell_type: 'code' })).toEqual({ added: 2, removed: 1 })
  expect(diffStats('NotebookEdit', { new_source: '', old_source: 'a\nb', edit_mode: 'delete', cell_type: 'code' })).toEqual({ added: 0, removed: 2 })
  expect(diffStats('Bash', { stdout: 'ok' })).toBeUndefined()
  expect(diffStats('Edit', 'Error: string not found')).toBeUndefined()
  expect(lineDiff('a\nb\nc\nd', 'a\nx\nc\ny\nd')).toEqual({ added: 2, removed: 1 })
  expect(summarize({ tools: 3, failed: 0, slowest: { description: 'Run tests', ms: 4_000 }, diff: { added: 120, removed: 30 } })).toBe(
    '3 tools · +120/-30 lines · slowest: Run tests 4.0s',
  )
})

test('an edit row shows +added/-removed in all four details, counted from the uncut result', async ($, on) => {
  detailEngine(on, {})
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const input = { command: 'edit a.ts', file_path: 'a.ts', old_string: 'a\nb', new_string: 'c\nd\ne\nf' }
  const edit = toolRow('e1', 'Edit', input, false, EDIT_RESULT)

  for (const detail of ['full', 'compact', 'input']) {
    await toolDetail($, detail)
    expect(await textsOf($, edit)).toEqual(['edit a.ts', '  Edit a.ts · ', '+4', '/', '-2'])
  }
  await toolDetail($, 'none')
  expect(await textsOf($, edit)).toEqual(['  Edit a.ts · ', '+4', '/', '-2'])

  // A failed edit draws no counts.
  await toolDetail($, 'full')
  expect(await textsOf($, toolRow('e2', 'Edit', input, true, 'Error: string not found'))).toEqual(['edit a.ts', '  Edit a.ts'])
})

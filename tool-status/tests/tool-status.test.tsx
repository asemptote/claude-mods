import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MountTarget } from 'claude-code/testing'
import type { On } from 'claude-code'

import { abbreviated, age, compact, describe, diffOf, numberCalls, sizeOf, sizeText, stepDetail, took } from '../hooks/format'
import { blockIndents, cutSegments, gutterPads, splitCommand } from '../hooks/highlight'
import type { Shell } from '../hooks/highlight'

const PLUGIN = 'tool-status'
const START = { cwd: '.', surface: 'terminal', isInteractive: true } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

const spinner = (props: Partial<{ message: string | null; mode: 'thinking' | 'tool-use' }> = {}, requestId?: string) =>
  ({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Spinner',
    ...(requestId !== undefined && { requestId }),
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking', ...props },
  }) as const

const toolRow = (
  id: string,
  tool: string,
  input: unknown,
  more: { isErrored?: boolean; isRunning?: boolean; isInterrupted?: boolean; isExpanded?: boolean; output?: unknown } = {},
) =>
  ({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false, ...more },
  }) as const

const BASH = { tool: 'Bash', command: 'npm test', description: 'Run tests' } as const

// The engine beneath the mod: a tool that answers once released (failing, or
// answering `result`), plain drawings of the spinner and of tool rows.
function engine(on: On, { fails = false, result = { stdout: 'ok' } as unknown, stored = {} as Record<string, unknown> } = {}) {
  mock.store(on, stored)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  on('tool.call', async () => {
    await gate
    return fails ? { deny: 'failed in test' } : { result: result as never }
  })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.message ?? e.props.word}${e.props.suffix}`}</Text>
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    const command = (e.props.input as { command?: string }).command
    return <Text>{command ?? `${e.props.tool}(…)`}</Text>
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{(e.props.output as { stdout: string }).stdout}</Text>
  })
  return { release }
}

type Mounted = Pick<Awaited<ReturnType<Engine['ui']['mount']>>, 'findAll'>

// What a drawing reads: its Code blocks' sources, its Texts, then a line's
// `Client` as its runs joined by `|` (the first Text found in it is the outer
// one holding them all).
async function readTexts(ui: Mounted) {
  const codes = (await ui.findAll({ type: 'Code' })).map(found => found.text)
  // The rule closing an expanded row reads as `rule`.
  const texts = [...codes, ...(await ui.findAll({ type: 'Text' })).map(found => (/^─+$/.test(found.text) ? 'rule' : found.text))]
  for (const client of await ui.findAll({ type: 'Client' })) {
    const runs = (await ui.findAll({ type: 'Text', in: client.key })).slice(1)
    texts.push(runs.map(found => found.text).join('|'))
  }
  return texts
}

async function textsOf($: Engine, target: MountTarget) {
  const ui = await $.ui.mount(target)
  const texts = await readTexts(ui)
  await ui.unmount()
  return texts
}

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n')

test('a call is named by its description, else its tool and most telling argument', () => {
  expect(describe('Bash', BASH)).toEqual({ label: 'Bash', detail: 'Run tests', text: 'Run tests' })
  expect(describe('Read', { file_path: 'C:\\src\\app.ts' })).toEqual({ label: 'Read', detail: 'app.ts', text: 'Read app.ts' })
  expect(describe('mcp__gh__search', { query: 'bugs' }).text).toBe('gh:search bugs')
  expect(describe('Bash', { command: '\n  cd x &&   make\nmore' }).text).toBe('Bash cd x && make')
  expect(describe('TodoWrite', { todos: [] })).toEqual({ label: 'TodoWrite', detail: undefined, text: 'TodoWrite' })
  expect(describe('Bash', { description: 'x'.repeat(200) }).text).toHaveLength(160)
  expect([age(64_000), age(3_725_000), took(2_500), took(38_000)]).toEqual(['1m 4s', '1h 2m', '2.5s', '38s'])
})

test('the spinner names the running tool with its description under it, then the time since it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const tool = engine(on)

  expect(await textsOf($, spinner())).toEqual(['Thinking…'])

  const call = $.tool.call({ ...BASH, tool_use_id: 't1' })
  await clock.settle()
  expect(await textsOf($, spinner())).toEqual(['Bash 0s', 'Run tests'])
  await clock.advance(5_000)
  expect(await textsOf($, spinner())).toEqual(['Bash 5s', 'Run tests'])
  // The row counts up while it runs.
  expect(await textsOf($, toolRow('t1', 'Bash', BASH, { isRunning: true }))).toEqual(['  Run tests| · |8 chars| · |5s'])

  tool.release()
  await call
  await clock.advance(12_000)
  expect(await textsOf($, spinner())).toEqual(['Thinking… 12s since Bash (5.0s)', 'Run tests'])
  // A state the engine names outranks the idle line.
  expect(await textsOf($, spinner({ message: 'Compacting' }))).toEqual(['Compacting…'])
  expect(await textsOf($, toolRow('t1', 'Bash', BASH))).toEqual(['  Run tests| · |8 chars| · |5.0s'])
})

test('parallel calls are counted, and a subagent keeps its own spinner', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const tool = engine(on)
  const calls = [
    $.tool.call({ ...BASH, tool_use_id: 'p1' }),
    $.tool.call({ tool: 'Read', tool_use_id: 'p2', file_path: '/a/b.ts' }),
    $.tool.call({ tool: 'Grep', tool_use_id: 's1', pattern: 'TODO', agentId: 'sub' } as never),
  ]
  await clock.settle()
  expect(await textsOf($, spinner())).toEqual(['Read 0s (+1 more)', 'b.ts'])
  expect(await textsOf($, spinner({}, 'sub'))).toEqual(['Grep 0s', 'TODO'])
  tool.release()
  await Promise.all(calls)
})

test("a subagent's turn starting leaves the main loop's running call on the spinner", async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const tool = engine(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const call = $.tool.call({ ...BASH, tool_use_id: 'm1' })
  await clock.settle()
  await $.turn.start({ text: 'look', turnId: 'sub-turn', agentId: 'sub' })
  expect(await textsOf($, spinner())).toEqual(['Bash 0s', 'Run tests'])
  tool.release()
  await call
})

test('a failed call is marked on the spinner and in red on its row', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const tool = engine(on, { fails: true })
  await $.session.start(START)

  const call = $.tool.call({ ...BASH, tool_use_id: 't2' })
  await clock.advance(3_000)
  tool.release()
  await call

  expect(await textsOf($, spinner())).toEqual(['Thinking… 0s since ✗ Bash (3.0s)', 'Run tests'])
  expect(await textsOf($, toolRow('t2', 'Bash', BASH, { isErrored: true }))).toEqual(['  Run tests| · |✗ failed after 3.0s'])
  // A failed row of a resumed session has no time to give.
  expect(await textsOf($, toolRow('old', 'Bash', BASH, { isErrored: true }))).toEqual(['  Run tests| · |✗ failed'])
})

test('a call moved to the background says so', async ($, on) => {
  mock.clock(on, { now: 0 })
  const result = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }
  const tool = engine(on, { result })
  tool.release()
  await $.tool.call({ ...BASH, tool_use_id: 'bg' })
  expect(await textsOf($, spinner())).toEqual(['Thinking… 0s since Bash (0.0s, backgrounded)', 'Run tests'])
  expect((await textsOf($, toolRow('bg', 'Bash', BASH, { output: result }))).at(-1)).toBe('  Run tests| · |8 chars| · |backgrounded')
})

test('Bash calls without a description are refused only when the option asks', async ($, on) => {
  const tool = engine(on)
  tool.release()
  expect(await $.tool.call({ tool: 'Bash', tool_use_id: 'n1', command: 'ls' })).not.toHaveProperty('deny')
})

test('requireBashDescription refuses a Bash call with no description before it runs', { options: { requireBashDescription: true } }, async ($, on) => {
  const tool = engine(on)
  tool.release()
  expect(await $.tool.call({ tool: 'Bash', tool_use_id: 'n2', command: 'ls' })).toMatchObject({ deny: expect.stringContaining('need a description') })
  expect(await $.tool.call({ ...BASH, tool_use_id: 'n3' })).not.toHaveProperty('deny')
})

test('a turn that ran a call ends with the idle line cleared and the footer saying Worked', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const tool = engine(on)
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
  expect(await textsOf($, spinner())).toEqual(['Thinking…'])
  const footer = { plugin: PLUGIN, surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 3000 } } as const
  expect(await textsOf($, footer)).toEqual(['Worked for 3s'])
})

test('compact cuts multi-line strings and runs of strings, leaving the rest', () => {
  expect(compact(lines(10), 10)).toBe(lines(10))
  expect(compact(lines(12), 10)).toBe(`${lines(9)}\n… +3 lines`)
  expect(compact({ stdout: lines(8), stderr: '', code: 0 }, 5)).toEqual({ stdout: `${lines(4)}\n… +4 lines`, stderr: '', code: 0 })
  const hunk = { oldStart: 1, lines: ['-a', '+b', ' c', ' d', ' e', ' f', ' g'] }
  expect(compact([hunk], 5)).toEqual([{ oldStart: 1, lines: ['-a', '+b', ' c', ' d', ' … +3 more'] }])
})

const toolDetail = ($: Engine, args: string) => $.command.run({ command: 'tool-detail', args, ...RUN })

const BIG = { command: lines(15, 'cmd'), description: 'Build it' }
const row = toolRow('c1', 'Bash', BIG)
const result = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'ToolResult',
  requestId: 'c1',
  props: { tool_use_id: 'c1', tool: 'Bash', output: { stdout: lines(9, 'out') }, isErrored: false },
} as const
const rowsOf = async ($: Engine) => ({ row: await textsOf($, row), result: await textsOf($, result) })

test('/tool-detail draws none, compact, input, output and full rows, steps without an argument, and is kept across sessions', async ($, on) => {
  engine(on)
  await $.session.start(START)

  // A session with nothing stored starts at the line alone.
  expect(await rowsOf($)).toEqual({ row: ['  Build it| · |80 chars'], result: [] })
  expect((await toolDetail($, '')).text).toBe('Tool detail: compact (inputs cut to 10 lines, outputs to 5).')
  expect(await rowsOf($)).toEqual({ row: [lines(9, 'cmd'), '… +6 lines', '  Build it| · |80 chars'], result: [`${lines(4, 'out')}\n… +5 lines`, 'rule'] })
  expect((await toolDetail($, '')).text).toContain('Tool detail: input')
  expect(await rowsOf($)).toEqual({ row: [lines(15, 'cmd'), 'rule', '  Build it| · |80 chars'], result: [] })
  expect((await toolDetail($, '')).text).toBe('Tool detail: output (outputs and the line, no inputs).')
  expect(await rowsOf($)).toEqual({ row: ['  Build it| · |80 chars'], result: [lines(9, 'out'), 'rule'] })
  expect((await toolDetail($, 'FULL')).text).toContain('Tool detail: full')
  expect(await rowsOf($)).toEqual({ row: [lines(15, 'cmd'), '  Build it| · |80 chars'], result: [lines(9, 'out'), 'rule'] })
  expect((await toolDetail($, '')).text).toContain('Tool detail: none')
  expect((await toolDetail($, 'maybe')).text).toBe('Usage: /tool-detail [none|compact|input|output|full]')

  await toolDetail($, 'input')
  await $.session.start(START)
  expect((await rowsOf($)).row).toEqual([lines(15, 'cmd'), 'rule', '  Build it| · |80 chars'])
})

test('the ctrl+o transcript draws rows at the detail chosen, and a click steps them', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const expanded = toolRow('c1', 'Bash', BIG, { isExpanded: true })
  expect(await textsOf($, expanded)).toEqual(['  Build it| · |80 chars'])
  const ui = await $.ui.mount(expanded)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'right' })
  expect(await readTexts(ui)).toEqual([lines(15, 'cmd'), '  Build it| · |80 chars'])
  expect(await textsOf($, { ...result, props: { ...result.props, isExpanded: true } })).toEqual([lines(9, 'out'), 'rule'])
  await ui.unmount()
})

test("ctrl+o folds another party's message to its sender and first line, and a click steps it", async ($, on) => {
  engine(on)
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  await $.session.start(START)
  const body = lines(12, 'msg')
  const message = (isExpanded: boolean, from?: { name: string }) =>
    ({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'UserMessage',
      requestId: 'u1',
      props: { text: body, origin: { kind: 'composer' }, isExpanded, ...(from !== undefined && { from }) },
    }) as const

  expect(await textsOf($, message(false, { name: 'Explore' }))).toEqual([body])
  expect(await textsOf($, message(true))).toEqual([body])
  expect(await textsOf($, message(true, { name: 'Explore' }))).toEqual(['  Explore: msg1| · |12 lines'])
  const ui = await $.ui.mount(message(true, { name: 'Explore' }))
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left' })
  expect(await readTexts(ui)).toEqual([`${lines(9, 'msg')}\n… +3 lines`, '  Explore: msg1| · |12 lines'])
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'right' })
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'right' })
  expect(await readTexts(ui)).toEqual([body, '  Explore: msg1| · |12 lines'])
  await ui.unmount()
})

test("a click on a row's line steps that row: left forward, right or ctrl+left back, inverted under the pointer", async ($, on) => {
  const cycle = ['none', 'compact', 'input', 'output', 'full'] as const
  expect(cycle.map(d => stepDetail(d, 1))).toEqual(['compact', 'input', 'output', 'full', 'none'])
  expect(cycle.map(d => stepDetail(d, -1))).toEqual(['full', 'none', 'compact', 'input', 'output'])
  engine(on)
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    await toolDetail($, 'none')
    const ui = await $.ui.mount({ ...row, surface })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect((await ui.find({ type: 'Client' }))?.key).toBe('tool-detail')
    const click = (more: { button: 'left' | 'right' | 'middle'; ctrl?: true }) => ui.pointer({ type: 'down', x: 2, y: 0, ...more })

    await click({ button: 'left' })
    expect(await textsOf($, result)).toEqual([`${lines(4, 'out')}\n… +5 lines`, 'rule'])
    await click({ button: 'left' })
    expect(await textsOf($, result)).toEqual([])
    await click({ button: 'right' })
    await click({ button: 'right' })
    expect(await readTexts(ui)).toEqual(['  Build it| · |80 chars'])
    await click({ button: 'left', ctrl: true })
    expect(await textsOf($, result)).toEqual([lines(9, 'out'), 'rule'])
    await click({ button: 'middle' })
    expect(await textsOf($, result)).toEqual([lines(9, 'out'), 'rule'])

    // Only the clicked row changed, and the command's choice is every row's again.
    expect(await textsOf($, toolRow('c2', 'Bash', BIG))).toEqual(['  Build it| · |80 chars'])
    await toolDetail($, 'none')
    expect(await readTexts(ui)).toEqual(['  Build it| · |80 chars'])

    const inverted = async () => (await ui.findAll({ type: 'Text', in: 'tool-detail' })).some(found => found.props.inverse === true)
    expect(await inverted()).toBe(false)
    await ui.pointer({ type: 'enter', x: 2, y: 0 })
    expect(await inverted()).toBe(true)
    await ui.pointer({ type: 'leave', x: 2, y: 0 })
    expect(await inverted()).toBe(false)
    // A pointer sweeping across in one frame: the leave comes before the
    // enter's redraw, and must still clear it.
    await Promise.all([ui.pointer({ type: 'enter', x: 2, y: 0 }), ui.pointer({ type: 'leave', x: 2, y: 0 })])
    expect(await inverted()).toBe(false)
    await ui.unmount()
  }
})

test('where no Client is drawn the line is a Button that steps its row forward', async ($, on) => {
  engine(on)
  await $.session.start({ ...START, surface: 'mobile' })
  const ui = await $.ui.mount({ ...row, surface: 'mobile' })
  expect((await ui.find({ type: 'Button' }))?.props).toMatchObject({ key: 'tool-detail' })
  await ui.press({ key: 'tool-detail' })
  await ui.unmount()
  expect(await textsOf($, row)).toEqual([lines(9, 'cmd'), '… +6 lines', '  Build it| · |80 chars'])
})

// An edit whose patch runs past compact's 5 lines: 4 added, 2 removed.
const EDIT_RESULT = {
  filePath: 'a.ts',
  originalFile: 'a\nb\ng',
  structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, lines: ['-a', '-b', '+c', '+d', '+e', '+f', ' g'] }],
}

test('counts the lines a call added and removed, by the shape of its result', () => {
  expect(diffOf(EDIT_RESULT)).toEqual({ added: 4, removed: 2 })
  expect(diffOf({ ...EDIT_RESULT, staged: true })).toBeUndefined()
  expect(diffOf({ type: 'create', filePath: 'b.ts', content: 'a\nb\nc\n', structuredPatch: [] })).toEqual({ added: 3, removed: 0 })
  expect(diffOf({ type: 'update', filePath: 'b.ts', content: '', structuredPatch: [] })).toBeUndefined()
  const bashEditDiff = {
    files: [
      { filePath: 'x', hunks: [{ lines: ['+1', '+2', '-3'] }] },
      { filePath: 'y', hunks: [{ lines: ['+4'] }] },
    ],
    moreFiles: 0,
  }
  expect(diffOf({ stdout: '', bashEditDiff })).toEqual({ added: 3, removed: 1 })
  expect(diffOf({ stdout: 'ok' })).toBeUndefined()
  expect(diffOf('Error: string not found')).toBeUndefined()
})

test('an edit row shows +added/-removed in every detail, counted from the uncut result', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const input = { file_path: '/src/a.ts', old_string: 'a\nb', new_string: 'c\nd\ne\nf' }
  const edit = toolRow('e1', 'Edit', input, { output: EDIT_RESULT })
  for (const detail of ['full', 'compact', 'input']) {
    await toolDetail($, detail)
    // Laid out bottom up, the row's tree holds its closing rule first.
    const rule = detail === 'input' ? ['rule'] : []
    expect(await textsOf($, edit)).toEqual([...rule, 'Edit(…)', '  Edit a.ts| · |+4|/|-2'])
  }
  for (const detail of ['none', 'output']) {
    await toolDetail($, detail)
    expect(await textsOf($, edit)).toEqual(['  Edit a.ts| · |+4|/|-2'])
    // With no engine row drawn, the line says a call was interrupted.
    expect(await textsOf($, toolRow(`i-${detail}`, 'Edit', input, { isInterrupted: true }))).toEqual(['  Edit a.ts| · |interrupted'])
  }
  // A failed edit draws no counts.
  expect(await textsOf($, toolRow('e2', 'Edit', input, { isErrored: true, output: 'Error: string not found' }))).toEqual(['  Edit a.ts| · |✗ failed'])
})

const numberedRow = (id: string, n?: number) => (n === undefined ? ['  Run tests| · |8 chars'] : [`  ${n}. |Run tests| · |8 chars`])

test("in ctrl+o a main-loop row opens with its place since the prompt, which an interruption doesn't start over", async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on).release()
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const turn = async (text: string, ids: string[], isAborted = false) => {
    await $.turn.start({ text, turnId: `turn ${text}` })
    for (const id of ids) await $.tool.call({ ...BASH, tool_use_id: id })
    await $.turn.complete({ answer: '', durationMs: 0, isAborted, turnId: `turn ${text}`, reason: isAborted ? 'aborted' : 'answer' })
  }

  await turn('go', ['a1', 'a2'])
  await $.tool.call({ ...BASH, tool_use_id: 's1', agentId: 'sub' } as never)
  await turn('next', ['b1'], true)
  await turn('after the interruption', ['b2'])
  // A turn started without a prompt goes on with the count.
  await turn('', ['b3'])
  await turn('again', ['c1'])

  const expected = { a1: 1, a2: 2, s1: undefined, b1: 1, b2: 2, b3: 3, c1: 1 }
  for (const [id, n] of Object.entries(expected)) {
    expect(await textsOf($, toolRow(id, 'Bash', BASH, { isExpanded: true }))).toEqual(numberedRow(id, n))
  }
  // The main view's line draws no number.
  expect(await textsOf($, toolRow('a2', 'Bash', BASH))).toEqual(['  Run tests| · |8 chars'])
})

test('numberRows off draws ctrl+o rows with no number', { options: { numberRows: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on).release()
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'go', turnId: 'go' })
  await $.tool.call({ ...BASH, tool_use_id: 'o1' })
  expect(await textsOf($, toolRow('o1', 'Bash', BASH, { isExpanded: true }))).toEqual(numberedRow('o1'))
})

// A transcript as `$.session.messages()` reads it: two prompts, the second
// interrupted and followed by another, then a row mid-turn after a result.
const asked = (text: string) => ({ role: 'user', text, toolUses: [] }) as const
const called = (...ids: string[]) => ({ role: 'assistant', text: '', toolUses: ids.map(tool_use_id => ({ tool_use_id, tool: 'Bash', input: {} })) }) as const
const answered = (...ids: string[]) =>
  ({ role: 'user', text: '', toolUses: [], toolResults: ids.map(tool_use_id => ({ tool_use_id, text: 'ok', isError: false })) }) as const
const TRANSCRIPT = [
  asked('go'),
  called('r1', 'r2'),
  answered('r1', 'r2'),
  { role: 'assistant', text: 'done', toolUses: [] },
  asked('next'),
  called('r3'),
  answered('r3'),
  asked('[Request interrupted by user for tool use]'),
  asked('go on'),
  called('r4'),
  answered('r4'),
  asked('Base directory for this skill: …'),
  called('r5'),
  answered('r5'),
] as const

test('a transcript numbers its calls the same way, an interruption or a row mid-turn starting no count', () => {
  const { numbers, count, isAnswered } = numberCalls(TRANSCRIPT)
  expect(Object.fromEntries(numbers)).toEqual({ r1: 1, r2: 2, r3: 1, r4: 2, r5: 3 })
  expect({ count, isAnswered }).toEqual({ count: 3, isAnswered: false })
})

test("a resumed session's rows are numbered from its transcript, and its count goes on", async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on).release()
  on('session.messages', () => ({ value: TRANSCRIPT }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.session.start(START)

  expect(await textsOf($, toolRow('r2', 'Bash', BASH, { isExpanded: true }))).toEqual(numberedRow('r2', 2))
  expect(await textsOf($, toolRow('r4', 'Bash', BASH, { isExpanded: true }))).toEqual(numberedRow('r4', 2))
  // The transcript ends mid-turn, so the next prompt goes on with its count.
  await $.turn.start({ text: 'more', turnId: 'more' })
  await $.tool.call({ ...BASH, tool_use_id: 'r6' })
  expect(await textsOf($, toolRow('r6', 'Bash', BASH, { isExpanded: true }))).toEqual(numberedRow('r6', 4))
})

test('parallel main-loop calls are numbered in the order they were made', async ($, on) => {
  mock.clock(on, { now: 0 })
  const tool = engine(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'go', turnId: 'go' })
  const ids = ['p1', 'p2', 'p3']
  const calls = ids.map(id => $.tool.call({ ...BASH, tool_use_id: id }))
  tool.release()
  await Promise.all(calls)
  for (const [i, id] of ids.entries()) {
    expect(await textsOf($, toolRow(id, 'Bash', BASH, { isExpanded: true }))).toEqual(numberedRow(id, i + 1))
  }
})

test("the transcript is read once, and never for a row this process saw run, a subagent's included", async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on).release()
  let reads = 0
  on('session.messages', () => {
    reads++
    return { value: TRANSCRIPT } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.session.start(START)
  await $.turn.start({ text: 'more', turnId: 'more' })
  await $.tool.call({ ...BASH, tool_use_id: 's1', agentId: 'sub' } as never)
  await $.tool.call({ ...BASH, tool_use_id: 'm1' })

  const row = (id: string) => textsOf($, toolRow(id, 'Bash', BASH, { isExpanded: true }))
  expect(await row('s1')).toEqual(numberedRow('s1'))
  expect(await row('m1')).toEqual(numberedRow('m1', 4))
  expect(await row('r2')).toEqual(numberedRow('r2', 2))
  // A call in no transcript and no record is unnumbered, and asks no read.
  expect(await row('elsewhere')).toEqual(numberedRow('elsewhere'))
  expect(reads).toBe(1)
})

test("a reload goes on with the count the host kept, not the transcript's", async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on).release()
  on('session.messages', () => ({ value: TRANSCRIPT }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.session.start(START)
  await $.turn.start({ text: 'more', turnId: 'more' })
  await $.tool.call({ ...BASH, tool_use_id: 'k1' })
  await $.tool.call({ ...BASH, tool_use_id: 'k2' })
  // A reload fires `session.start` again; the transcript, read then, still
  // ends at 3, behind the live count.
  await $.session.start(START)
  await $.tool.call({ ...BASH, tool_use_id: 'k3' })
  expect(await textsOf($, toolRow('k3', 'Bash', BASH, { isExpanded: true }))).toEqual(numberedRow('k3', 6))
})

const PY_HEREDOC = "cd src && uv run python - <<'EOF'\nimport json\nprint(json.dumps({}))\nEOF\necho done"

test('a command splits into its shell and the code it hands other languages', () => {
  // No other language: one shell block.
  expect(splitCommand('npm test && echo ok')).toEqual([{ text: 'npm test && echo ok', language: 'bash', line: 1 }])
  // A heredoc fed to python, through `uv run`, its delimiter line back in the shell.
  expect(splitCommand(PY_HEREDOC)).toEqual([
    { text: "cd src && uv run python - <<'EOF'", language: 'bash', line: 1 },
    { text: 'import json\nprint(json.dumps({}))', language: 'python', line: 2 },
    { text: 'EOF\necho done', language: 'bash', line: 4 },
  ])
  // A heredoc written to a file takes the file's name; one to nothing is plain.
  expect(splitCommand('cat > run.py <<EOF\nx = 1\nEOF')).toEqual([
    { text: 'cat > run.py <<EOF', language: 'bash', line: 1 },
    { text: 'x = 1', path: 'run.py', line: 2 },
    { text: 'EOF', language: 'bash', line: 3 },
  ])
  expect(splitCommand(`git commit -m "$(cat <<'EOF'\nFix it's bug\nEOF\n)"`)).toEqual([
    { text: `git commit -m "$(cat <<'EOF'`, language: 'bash', line: 1 },
    { text: "Fix it's bug", line: 2 },
    { text: 'EOF\n)"', language: 'bash', line: 3 },
  ])
  // A multi-line -c argument is code; a one-line one stays in the shell.
  expect(splitCommand('python3 -c "\nimport sys\nprint(sys.argv)\n" | head')).toEqual([
    { text: 'python3 -c "', language: 'bash', line: 1 },
    { text: 'import sys\nprint(sys.argv)', language: 'python', line: 2 },
    { text: '" | head', language: 'bash', line: 4 },
  ])
  expect(splitCommand("python -c 'print(1)'")).toEqual([{ text: "python -c 'print(1)'", language: 'bash', line: 1 }])
  expect(splitCommand("node -e '\nconsole.log(1)\n'")[1]).toEqual({ text: 'console.log(1)', language: 'javascript', line: 2 })
  // Only an interpreter, or one run through a wrapper, reads code.
  expect(splitCommand('echo python <<EOF\nx\nEOF')[1]).toEqual({ text: 'x', line: 2 })
  expect(splitCommand("grep -c 'a\nb' f")).toHaveLength(1)
  // Shell code handed to a shell is split again.
  expect(splitCommand("ssh box 'cd /srv\npython - <<EOF\nprint(1)\nEOF\n'")).toEqual([
    { text: "ssh box 'cd /srv\npython - <<EOF", language: 'bash', line: 1 },
    { text: 'print(1)', language: 'python', line: 3 },
    { text: "EOF\n'", language: 'bash', line: 4 },
  ])
  // `<<-` strips tabs before the delimiter; an unclosed heredoc runs to the end.
  expect(splitCommand('psql <<-SQL\n\tselect 1;\n\tSQL\nls')[1]).toEqual({ text: '\tselect 1;', language: 'sql', line: 2 })
  expect(splitCommand('python <<EOF\nprint(1)')).toEqual([
    { text: 'python <<EOF', language: 'bash', line: 1 },
    { text: 'print(1)', language: 'python', line: 2 },
  ])
})

test('a file the engine cannot place by its extension is written in its language, named outright', () => {
  expect(splitCommand('cat > run.jl <<EOF\nx = 1\nEOF')[1]).toEqual({ text: 'x = 1', language: 'julia', line: 2 })
  expect(splitCommand("cat <<'EOF' > src/Model.JL\nf(x) = x\nEOF")[1]).toEqual({ text: 'f(x) = x', language: 'julia', line: 2 })
  expect(splitCommand("Set-Content run.jl -Value @'\nx = 1\n'@", 'powershell')[1]).toEqual({ text: 'x = 1', language: 'julia', line: 2 })
  // Others keep their path, for the engine to place.
  expect(splitCommand('cat > run.py <<EOF\nx = 1\nEOF')[1]).toEqual({ text: 'x = 1', path: 'run.py', line: 2 })
})

test("a block says the command's line it starts on, a mid-line one sharing it, CRLF counted as one break", () => {
  // `-c` code opening mid-line shares line 1 with the shell before it.
  expect(splitCommand('python -c "import x\nprint(1)"').map(s => [s.language, s.line])).toEqual([
    ['bash', 1],
    ['python', 1],
    ['bash', 2],
  ])
  // A here-string's body starts past its opening line break, CRLF or LF.
  const ps = "Get-Date\r\n@'\r\nprint(1)\r\nprint(2)\r\n'@ | python -"
  expect(splitCommand(ps, 'powershell').map(s => [s.text, s.line])).toEqual([
    ["Get-Date\r\n@'", 1],
    ['print(1)\r\nprint(2)', 3],
    ["'@ | python -", 5],
  ])
  // Lines between blocks left out still count.
  expect(splitCommand('cd a\n\n\npython - <<EOF\nx = 1\nEOF').map(s => s.line)).toEqual([1, 5, 6])
})

// Commands of every shape the splitter reads, each mutated below as a model
// might cut or garble it.
const SHAPES: [string, Shell][] = [
  [PY_HEREDOC, 'bash'],
  ['cat > run.py <<EOF\nx = 1\nEOF', 'bash'],
  [`git commit -m "$(cat <<'EOF'\nFix it's bug\nEOF\n)"`, 'bash'],
  ['python3 -c "\nimport sys\nprint(sys.argv)\n" | head', 'bash'],
  ['python -c "import x\nprint(1)"', 'bash'],
  ["node -e '\nconsole.log(`a ${1}`)\n'", 'bash'],
  ["ssh box 'cd /srv\npython - <<EOF\nprint(1)\nEOF\n'", 'bash'],
  ["bash -c \"echo $(date) && python3 - <<'PY'\nx = '\\\"'\nPY\n\"", 'bash'],
  ['psql <<-SQL\n\tselect 1;\n\tSQL\nls', 'bash'],
  ['X=1 uv run python <<EOF\nprint(1)', 'bash'],
  ["Get-Date\r\n@'\r\nprint(1)\r\n'@ | python -", 'powershell'],
  ["python -c @'\nimport os\nprint(os.getcwd())\n'@", 'powershell'],
  ['Set-Content run.js -Value @"\nconsole.log($x)\n"@\nnode run.js', 'powershell'],
  ["pwsh -c \"& 'C:\\py\\python.exe' -c 'print(1)'\" <# note #> ; `\n echo ok", 'powershell'],
]

// What every split keeps, however broken its command: no throw, every
// non-space character in some block, and each block on the line it says.
function splitHolds(command: string, shell: Shell) {
  const blocks = splitCommand(command, shell)
  const squash = (text: string) => text.replace(/\s+/g, '')
  if (squash(blocks.map(b => b.text).join('')) !== squash(command)) return `lost text: ${JSON.stringify(command)}`
  const lines = command.split('\n')
  let previous = 0
  for (const block of blocks) {
    const first = block.text.split('\n')[0]!.replace(/\r$/, '')
    if (block.line < previous || !(lines[block.line - 1] ?? '').includes(first)) return `line ${block.line} wrong: ${JSON.stringify(command)}`
    previous = block.line
  }
  return undefined
}

test('any command splits without loss, each block on its line: cut, garbled or CRLF, in either shell', () => {
  const failures: string[] = []
  let runs = 0
  const check = (command: string, shell: Shell) => {
    runs++
    try {
      const failure = splitHolds(command, shell)
      if (failure !== undefined) failures.push(`${shell} ${failure}`)
    } catch (error) {
      failures.push(`${shell} threw ${String(error)}: ${JSON.stringify(command)}`)
    }
  }
  for (const [command, own] of SHAPES) {
    for (const shell of [own, own === 'bash' ? 'powershell' : 'bash'] as const) {
      check(command.replace(/\r?\n/g, '\r\n'), shell)
      for (let at = 0; at <= command.length; at++) {
        check(command.slice(0, at), shell)
        check(command.slice(0, at) + command.slice(at + 1), shell)
        for (const c of `'"\`@<($`) check(command.slice(0, at) + c + command.slice(at), shell)
      }
    }
  }
  expect(failures.slice(0, 5)).toEqual([])
  expect(runs).toBeGreaterThan(10_000)
})

test('blocks are cut to a number of lines in all, saying how many are left out', () => {
  const blocks = splitCommand(PY_HEREDOC)
  expect(cutSegments(blocks, 10)).toEqual({ segments: blocks, hidden: 0 })
  expect(cutSegments(blocks, 3)).toEqual({
    segments: [blocks[0], { text: 'import json', language: 'python', line: 2 }],
    hidden: 3,
  })
})

test('a shell row past none draws its command highlighted, Bash and PowerShell alike, but not in output; full keeps the engine row', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await toolDetail($, 'input')
  const bash = toolRow('h1', 'Bash', { command: PY_HEREDOC, description: 'Dump it' })
  const ui = await $.ui.mount(bash)
  const codes = await ui.findAll({ type: 'Code' })
  expect(codes.map(c => c.props.language)).toEqual(['bash', 'python', 'bash'])
  expect(codes[1]!.text).toBe('import json\nprint(json.dumps({}))')
  expect(await readTexts(ui)).toEqual([...codes.map(c => c.text), 'rule', '  Dump it| · |81 chars'])
  await ui.unmount()

  const ps = await $.ui.mount(toolRow('p1', 'PowerShell', { command: "@'\nprint(1)\n'@ | python -", description: 'Run it' }))
  expect((await ps.findAll({ type: 'Code' })).map(c => c.props.language)).toEqual(['powershell', 'python', 'powershell'])
  await ps.unmount()

  // In output the command is left out, the line alone over the output.
  await toolDetail($, 'output')
  expect(await textsOf($, bash)).toEqual(['  Dump it| · |81 chars'])

  await toolDetail($, 'full')
  expect(await textsOf($, bash)).toEqual([PY_HEREDOC, '  Dump it| · |81 chars'])
})

const startLines = async ($: Engine, target: MountTarget) => {
  const ui = await $.ui.mount(target)
  const found = (await ui.findAll({ type: 'Code' })).map(c => c.props.startLine)
  await ui.unmount()
  return found
}

test("a highlighted command's blocks are numbered by the command's lines, compact's cut ones too", async ($, on) => {
  engine(on)
  await $.session.start(START)
  await toolDetail($, 'input')
  expect(await startLines($, toolRow('g1', 'Bash', { command: PY_HEREDOC, description: 'Dump it' }))).toEqual([1, 2, 4])
  await toolDetail($, 'compact')
  const long = `python - <<EOF\n${lines(20, 'x = ')}\nEOF`
  expect(await startLines($, toolRow('g2', 'Bash', { command: long, description: 'Long' }))).toEqual([1, 2])
})

test('blocks are set in by the gutter columns they lack, so every number ends in one column', () => {
  // Lines 1-2 in the shell, 3-12 in Python, 13 back in the shell: one digit, then two.
  const command = `cd src\npython - <<'EOF'\n${lines(9, 'x = ')}\nEOF`
  const blocks = splitCommand(command)
  expect(blocks.map(b => b.line)).toEqual([1, 3, 12])
  expect(gutterPads(blocks)).toEqual([1, 0, 0])
  expect(gutterPads(splitCommand(PY_HEREDOC))).toEqual([0, 0, 0])
  expect(gutterPads([])).toEqual([])
})

test('a block in another language is set a level in, its gutter with it; one in the same shell is not', () => {
  const command = `cd src\npython - <<'EOF'\n${lines(9, 'x = ')}\nEOF`
  expect(blockIndents(splitCommand(command), 'bash', true)).toEqual([1, 2, 0])
  expect(blockIndents(splitCommand(command), 'bash', false)).toEqual([0, 2, 0])
  // Bash inside bash stays at the shell's level; a commit message's plain text goes in.
  expect(blockIndents(splitCommand("ssh box 'cd /srv\npython - <<EOF\nprint(1)\nEOF\n'"), 'bash', false)).toEqual([0, 2, 0])
  expect(blockIndents(splitCommand(`git commit -F - <<'EOF'\nFix it\nEOF`), 'bash', false)).toEqual([0, 2, 0])
  expect(blockIndents(splitCommand("@'\nprint(1)\n'@ | python -", 'powershell'), 'powershell', false)).toEqual([0, 2, 0])
})

test('a row sets each block in by its pad, and none without a gutter', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await toolDetail($, 'input')
  const command = `python - <<'EOF'\n${lines(12, 'x = ')}\nEOF`
  const ui = await $.ui.mount(toolRow('g4', 'Bash', { command, description: 'Long' }))
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(b => b.key?.startsWith('code-')).map(b => b.props.paddingLeft)).toEqual([1, 2, 0])
  await ui.unmount()
})

test('numberInputLines off draws no gutter', { options: { numberInputLines: false } }, async ($, on) => {
  engine(on)
  await $.session.start(START)
  await toolDetail($, 'input')
  expect(await startLines($, toolRow('g3', 'Bash', { command: PY_HEREDOC, description: 'Dump it' }))).toEqual([undefined, undefined, undefined])
})

test('highlightCommands off leaves the command to the engine row', { options: { highlightCommands: false } }, async ($, on) => {
  engine(on)
  await $.session.start(START)
  await toolDetail($, 'input')
  expect(await textsOf($, toolRow('h1', 'Bash', { command: PY_HEREDOC, description: 'Dump it' }))).toEqual(['rule', PY_HEREDOC, '  Dump it| · |81 chars'])
})

test("a tool whose row the engine draws empty is the line alone in every detail, never the engine's row", async ($, on) => {
  engine(on)
  await $.session.start(START)
  const row = toolRow('la1', 'ListAgents', {}, { output: 'Peer sessions (0)' })
  for (const [detail, expected] of [
    ['compact', ['  ListAgents| · |→ 17 chars']],
    ['input', ['rule', '  ListAgents| · |→ 17 chars']],
    ['output', ['  ListAgents| · |→ 17 chars']],
    ['full', ['  ListAgents| · |→ 17 chars']],
  ] as const) {
    await toolDetail($, detail)
    expect(await textsOf($, row)).toEqual(expected)
  }
})

const childTypes = (box: { children: unknown[] }) => box.children.map(child => (child as { type?: string }).type)

test('past none the line heads the row with no blank line, a rule closes it, and the line stays on top to be clicked', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const edit = toolRow('o1', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, { output: EDIT_RESULT })

  // Over the engine's row: laid out bottom up, so the line, on top, is drawn
  // last; the engine's row pulled up a line over its own top margin.
  await toolDetail($, 'full')
  const full = await $.ui.mount(edit)
  const [outer, engineRow] = await full.findAll({ type: 'Box' })
  expect(outer!.props).toMatchObject({ flexDirection: 'column-reverse' })
  expect(outer!.props.marginTop).toBeUndefined()
  expect(childTypes(outer!)).toEqual(['Box', 'Client'])
  expect(engineRow!.props.marginTop).toBe(-1)
  await full.unmount()
  // The output closes with the rule in compact, output and full, the input in input.
  expect(await textsOf($, { ...result, requestId: 'o1', props: { ...result.props, tool_use_id: 'o1' } })).toEqual([lines(9, 'out'), 'rule'])
  await toolDetail($, 'input')
  const input = await $.ui.mount(edit)
  expect(childTypes((await input.findAll({ type: 'Box' }))[0]!)).toEqual(['Box', 'Box', 'Client'])
  expect(await input.find({ type: 'Box', key: 'tool-rule' })).toBeDefined()
  await input.unmount()

  // A highlighted row draws no engine row, so it lies top down.
  const highlighted = await $.ui.mount(toolRow('o2', 'Bash', BIG))
  expect(childTypes((await highlighted.findAll({ type: 'Box' }))[0]!)).toEqual(['Client', 'Box', 'Box'])
  await highlighted.unmount()

  // In none the rows stack, the line alone.
  await toolDetail($, 'none')
  const bare = await $.ui.mount(edit)
  expect(await bare.findAll({ type: 'Box' })).toEqual([])
  await bare.unmount()
})

test('a call is sized in characters: its command or prompt in, its main text out', () => {
  expect(sizeOf({ command: 'a\nb\nc' }, { stdout: 'x\ny\n', stderr: 'warn' })).toEqual({ input: 5, output: 8 })
  expect(sizeOf({ file_path: 'a.ts' }, { type: 'text', file: { content: 'hello', numLines: 1 } }).output).toBe(5)
  expect(sizeOf({ pattern: 'x' }, { mode: 'content', filenames: [], content: 'a\nb', numLines: 2 }).output).toBe(3)
  expect(sizeOf({ pattern: '*.ts' }, { filenames: ['a', 'bb'], numFiles: 2 }).output).toBe(4)
  expect(sizeOf({ prompt: 'go' }, { content: [{ type: 'text', text: 'one\ntwo' }] })).toEqual({ input: 2, output: 7 })
  expect(sizeOf({ url: 'u', prompt: 'p' }, { result: 'r1\nr2' }).output).toBe(5)
  expect(sizeOf({ q: 1 }, [{ type: 'text', text: 'mcp' }]).output).toBe(3)
  // A file change has its +/- instead.
  expect(sizeOf({ file_path: 'a' }, { structuredPatch: [{ lines: ['+a'] }] }).output).toBeUndefined()
})

test('a size reads input then output, exact under a hundred and cut short past it', () => {
  expect(sizeText({ input: 42, output: 1204 })).toBe('42 → 1.2k chars')
  expect(sizeText({ input: 31_204, output: 2_400_000 })).toBe('31k → 2.4M chars')
  expect(sizeText({ input: 1, output: undefined })).toBe('1 char')
  expect(sizeText({ input: 8, output: 0 })).toBe('8 → 0 chars')
  expect(sizeText({ input: undefined, output: 85 })).toBe('→ 85 chars')
  expect(sizeText({ input: undefined, output: undefined })).toBeUndefined()
  expect([99, 100, 150, 949, 950, 1000, 1050, 9_960, 10_400, 999_499, 999_500, 12_345_678].map(abbreviated)).toEqual([
    '99',
    '0.1k',
    '0.2k',
    '0.9k',
    '1k',
    '1k',
    '1.1k',
    '10k',
    '10k',
    '999k',
    '1M',
    '12M',
  ])
})

test("a row's line says its input's size while it runs, its output's once finished, and none once failed", async ($, on) => {
  engine(on)
  await $.session.start(START)
  const ran = toolRow('s1', 'Bash', { command: 'make\nmake test', description: 'Build' }, { output: { stdout: lines(40), stderr: '' } })
  expect(await textsOf($, ran)).toEqual(['  Build| · |14 → 0.2k chars'])
  const running = toolRow('s2', 'Bash', { command: 'make\nmake test', description: 'Build' }, { isRunning: true })
  expect(await textsOf($, running)).toEqual(['  Build| · |14 chars| · |running'])
  const failed = toolRow('s3', 'Bash', { command: 'make\nmake test', description: 'Build' }, { isErrored: true, output: 'boom' })
  expect(await textsOf($, failed)).toEqual(['  Build| · |✗ failed'])
})

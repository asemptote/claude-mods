import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MountTarget } from 'claude-code/testing'
import type { On } from 'claude-code'

import { age, compact, describe, diffOf, numberCalls, stepDetail, took } from '../hooks/format'

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

const toolRow = (id: string, tool: string, input: unknown, more: { isErrored?: boolean; isRunning?: boolean; isExpanded?: boolean; output?: unknown } = {}) =>
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

// What a drawing reads: its Texts, then a line's `Client` as its runs joined
// by `|` (the first Text found in it is the outer one holding them all).
async function readTexts(ui: Mounted) {
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
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
  expect(await textsOf($, toolRow('t1', 'Bash', BASH, { isRunning: true }))).toEqual(['  Run tests| · |5s'])

  tool.release()
  await call
  await clock.advance(12_000)
  expect(await textsOf($, spinner())).toEqual(['Thinking… 12s since Bash (5.0s)', 'Run tests'])
  // A state the engine names outranks the idle line.
  expect(await textsOf($, spinner({ message: 'Compacting' }))).toEqual(['Compacting…'])
  expect(await textsOf($, toolRow('t1', 'Bash', BASH))).toEqual(['  Run tests| · |5.0s'])
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
  expect((await textsOf($, toolRow('bg', 'Bash', BASH, { output: result }))).at(-1)).toBe('  Run tests| · |backgrounded')
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

test('/tool-detail draws none, compact, input and full rows, steps without an argument, and is kept across sessions', async ($, on) => {
  engine(on)
  await $.session.start(START)

  // A session with nothing stored starts at the line alone.
  expect(await rowsOf($)).toEqual({ row: ['  Build it'], result: [] })
  expect((await toolDetail($, '')).text).toBe('Tool detail: compact (inputs cut to 10 lines, outputs to 5).')
  expect(await rowsOf($)).toEqual({ row: [`${lines(9, 'cmd')}\n… +6 lines`, '  Build it'], result: [`${lines(4, 'out')}\n… +5 lines`] })
  expect((await toolDetail($, '')).text).toContain('Tool detail: input')
  expect(await rowsOf($)).toEqual({ row: [lines(15, 'cmd'), '  Build it'], result: [] })
  expect((await toolDetail($, 'FULL')).text).toContain('Tool detail: full')
  expect(await rowsOf($)).toEqual({ row: [lines(15, 'cmd'), '  Build it'], result: [lines(9, 'out')] })
  expect((await toolDetail($, '')).text).toContain('Tool detail: none')
  expect((await toolDetail($, 'maybe')).text).toBe('Usage: /tool-detail [none|compact|input|full]')

  await toolDetail($, 'input')
  await $.session.start(START)
  expect((await rowsOf($)).row).toEqual([lines(15, 'cmd'), '  Build it'])
})

test('the ctrl+o transcript draws rows at the detail chosen, and a click steps them', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const expanded = toolRow('c1', 'Bash', BIG, { isExpanded: true })
  expect(await textsOf($, expanded)).toEqual(['  Build it'])
  const ui = await $.ui.mount(expanded)
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'right' })
  expect(await readTexts(ui)).toEqual([lines(15, 'cmd'), '  Build it'])
  expect(await textsOf($, { ...result, props: { ...result.props, isExpanded: true } })).toEqual([lines(9, 'out')])
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
  expect((['none', 'compact', 'input', 'full'] as const).map(d => stepDetail(d, 1))).toEqual(['compact', 'input', 'full', 'none'])
  expect((['none', 'compact', 'input', 'full'] as const).map(d => stepDetail(d, -1))).toEqual(['full', 'none', 'compact', 'input'])
  engine(on)
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    await toolDetail($, 'none')
    const ui = await $.ui.mount({ ...row, surface })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect((await ui.find({ type: 'Client' }))?.key).toBe('tool-detail')
    const click = (more: { button: 'left' | 'right' | 'middle'; ctrl?: true }) => ui.pointer({ type: 'down', x: 2, y: 0, ...more })

    await click({ button: 'left' })
    expect(await textsOf($, result)).toEqual([`${lines(4, 'out')}\n… +5 lines`])
    await click({ button: 'left' })
    expect(await textsOf($, result)).toEqual([])
    await click({ button: 'right' })
    await click({ button: 'right' })
    expect(await readTexts(ui)).toEqual(['  Build it'])
    await click({ button: 'left', ctrl: true })
    expect(await textsOf($, result)).toEqual([lines(9, 'out')])
    await click({ button: 'middle' })
    expect(await textsOf($, result)).toEqual([lines(9, 'out')])

    // Only the clicked row changed, and the command's choice is every row's again.
    expect(await textsOf($, toolRow('c2', 'Bash', BIG))).toEqual(['  Build it'])
    await toolDetail($, 'none')
    expect(await readTexts(ui)).toEqual(['  Build it'])

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
  expect(await textsOf($, row)).toEqual([`${lines(9, 'cmd')}\n… +6 lines`, '  Build it'])
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
  const bashEditDiff = { files: [{ filePath: 'x', hunks: [{ lines: ['+1', '+2', '-3'] }] }, { filePath: 'y', hunks: [{ lines: ['+4'] }] }], moreFiles: 0 }
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
    expect(await textsOf($, edit)).toEqual(['Edit(…)', '  Edit a.ts| · |+4|/|-2'])
  }
  await toolDetail($, 'none')
  expect(await textsOf($, edit)).toEqual(['  Edit a.ts| · |+4|/|-2'])
  // A failed edit draws no counts.
  expect(await textsOf($, toolRow('e2', 'Edit', input, { isErrored: true, output: 'Error: string not found' }))).toEqual(['  Edit a.ts| · |✗ failed'])
})

const numberedRow = (id: string, n?: number) => (n === undefined ? ['  Run tests'] : [`  ${n}. |Run tests`])

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
  expect(await textsOf($, toolRow('a2', 'Bash', BASH))).toEqual(['  Run tests'])
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

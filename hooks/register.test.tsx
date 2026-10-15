import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { age, capped, chosen, diffOf, head, mainOf, storedText, took } from './register'

const SPINNER = {
  plugin: 'tool-status',
  component: 'Spinner',
  props: { word: '', message: null, suffix: '…', mode: 'tool-use' },
} as const

const OK = { result: { stdout: '', stderr: '', interrupted: false } }

// Stands for the engine beneath the plugin: draws the spinner's message (else
// its word), echoes turns, and holds every tool call until its gate opens,
// noting its id.
function engine(on: On) {
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.message ?? e.props.word}</Text>
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const gates: Array<() => void> = []
  const ids: string[] = []
  let calls = 0
  on('tool.call', async ($, e) => {
    ids.push(e.tool_use_id)
    calls += 1
    await new Promise<void>(r => gates.push(r))
    return OK
  })
  return { gates, ids, calls: () => calls }
}

test('what a call is doing: its most telling field\'s first line, whole', () => {
  expect(mainOf({ command: 'ls', description: 'List files' })).toBe('List files')
  expect(mainOf({ command: 'ls -la\nwc -l' })).toBe('ls -la')
  expect(mainOf({ file_path: '/x/y.ts' })).toBe('/x/y.ts')
  expect(mainOf({ description: 'Find docs', prompt: 'long…' })).toBe('Find docs')
  expect(mainOf({ todos: [] })).toBeUndefined()
  expect([age(0), age(59_999), age(65_000), age(3_725_000)]).toEqual(['0s', '59s', '1m 5s', '1h 2m'])
})

test('the spinner names the running call\'s tool with what it is doing whole under it, bold in the spinner\'s color, then the last one with its age and how long it ran, ticking until the turn ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { gates } = engine(on)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(await text()).toEqual([''])

  await $.turn.start({ text: 'hi', turnId: 't1' })
  const bash = $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files in the home directory' })
  const read = $.tool.call({ tool: 'Read', file_path: '/x/y.ts' })
  await clock.settle()
  expect(await text()).toEqual(['Read (+1 more)', '/x/y.ts'])

  gates[1]?.()
  await read
  expect(await text()).toEqual(['Bash', 'List files in the home directory'])
  expect((await ui.find({ type: 'Text', text: 'List files in the home directory' }))?.props).toMatchObject({ bold: true, color: 'claude' })
  await clock.advance(3_400)
  gates[0]?.()
  await bash
  expect(await text()).toEqual(['0s ago · Bash 3.4s', 'List files in the home directory'])

  // The ticker's seconds run from the turn's start, 0.4 s off the call's end.
  await clock.advance(65_600)
  expect(await text()).toEqual(['1m 5s ago · Bash 3.4s', 'List files in the home directory'])

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10_000)
  expect(await text()).toEqual(['1m 5s ago · Bash 3.4s', 'List files in the home directory'])
  await ui.unmount()
})

test('a call that ends is the idle line before it leaves the spinner, never the call before it', async ($, on) => {
  const clock = mock.clock(on)
  const { gates } = engine(on)
  let idle: string | undefined
  const shownAsLeft: Array<string | undefined> = []
  on('state.set', { plugin: 'tool-status', key: 'last' }, ($, e, next) => {
    idle = (e.value as { detail?: string } | null)?.detail
    return next(e)
  })
  on('state.set', { plugin: 'tool-status', key: 'running' }, ($, e, next) => {
    if ((e.value as unknown[]).length === 0) shownAsLeft.push(idle)
    return next(e)
  })
  for (const description of ['First', 'Second']) {
    const call = $.tool.call({ tool: 'Bash', command: 'ls', description })
    await clock.settle()
    gates.at(-1)?.()
    await call
  }
  expect(shownAsLeft).toEqual(['First', 'Second'])
})

test('an engine message outranks the idle line, never a running call', async ($, on) => {
  const clock = mock.clock(on)
  const { gates } = engine(on)
  const call = $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await clock.settle()
  gates[0]?.()
  await call
  const ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, message: 'Compacting conversation' }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Compacting conversation')
  await ui.unmount()
})

test('a failure after the call clears it from the spinner and does not run it twice', async ($, on) => {
  const clock = mock.clock(on)
  const { gates, calls } = engine(on)
  on('state.set', { plugin: 'tool-status', key: 'last' }, () => ({ deny: 'refused for the test' }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const call = $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await clock.settle()
  gates[0]?.()
  await call
  expect(calls()).toBe(1)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('')
  await ui.unmount()
})

const row = (tool: string, input: unknown) => ({
  plugin: 'tool-status',
  component: 'ToolUse',
  props: { tool_use_id: 'toolu_1', tool, input, isRunning: false, isErrored: false, isInterrupted: false },
} as const)

test('every tool row carries what its call was doing under the header: a dim arrow, then a button of it in bold in the spinner color that steps the view', async ($, on) => {
  mock.store(on)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tool}(…)</Text>
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>full output</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [tool, input, shown] of [
      ['Bash', { command: 'ls', description: 'List files' }, 'List files'],
      ['Read', { file_path: '/x/y.ts' }, '/x/y.ts'],
      ['TodoWrite', { todos: [] }, undefined],
    ] as const) {
      const ui = await $.ui.mount({ ...row(tool, input), surface })
      expect(await ui.find({ type: 'Text', text: `${tool}(…)` })).toBeDefined()
      const button = await ui.find({ type: 'Button' })
      expect(button === undefined).toBe(shown === undefined)
      if (button) {
        expect(button.props).toMatchObject({ plain: true })
        expect(button.props.action).toBeUndefined()
        expect((await ui.find({ type: 'Text', text: '  ↳ ' }))?.props.dimColor).toBe(true)
        expect((await ui.find({ type: 'Text', text: shown }))?.props).toMatchObject({ bold: true, color: 'claude' })
      }
      await ui.unmount()
    }
  }
  const ui = await $.ui.mount({ ...row('Bash', { command: 'ls', description: 'List files' }), surface: 'terminal' })
  const output = async () => {
    const drawn = await $.ui.mount({ ...result('toolu_old', 'Bash', { stdout: 'hello', stderr: '' }), surface: 'terminal' })
    const texts = (await drawn.findAll({ type: 'Text' })).map(t => t.text)
    await drawn.unmount()
    return texts
  }
  await ui.press({ plugin: 'tool-status', key: 'view' })
  expect(await output()).toEqual([])
  await ui.press({ plugin: 'tool-status', key: 'view' })
  expect(await output()).toEqual(['  ⎿ hello'])
  await ui.unmount()
})

const result = (id: string, tool: string, output: unknown, isErrored = false) => ({
  plugin: 'tool-status',
  component: 'ToolResult',
  requestId: id,
  props: { tool_use_id: id, tool, output, isErrored },
} as const)

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

test('/tool-output alone steps through the views; a name sets one; heads keep the first lines and count the rest', () => {
  expect([chosen('', 'none'), chosen(' ', 'compact'), chosen('', 'inputs'), chosen('', 'full')]).toEqual(['compact', 'inputs', 'full', 'none'])
  expect([chosen('INPUTS', 'none'), chosen('none', 'full')]).toEqual(['inputs', 'none'])
  expect(chosen('on', 'full')).toBe(null)
  expect(head(lines(7), 5)).toEqual({ lines: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'], more: 2 })
  expect(head('one\n\n', 5)).toEqual({ lines: ['one'], more: 0 })
  expect(head('  \n', 5)).toEqual({ lines: [], more: 0 })
  expect(capped({ command: 'a\nb\nc', description: 'x', timeout: 5 }, 2)).toEqual({ command: 'a\nb\n… +1 lines', description: 'x', timeout: 5 })
  expect(capped({ command: 'a\nb', description: 'x', timeout: 5 }, 0)).toEqual({ command: '', description: '', timeout: 5 })
  expect([storedText('text'), storedText({ stdout: 'out', stderr: 'err' }), storedText({ file: {} })]).toEqual(['text', 'out\nerr', undefined])
})

// What the engine stamps on a command typed at the prompt.
const typed = (args: string) =>
  ({ command: 'tool-output', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }) as const

function session(on: On, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>full output</Text>
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    const command = (e.props.input as { command?: string }).command
    return <Text>{e.props.tool}({command ?? '…'})</Text>
  })
  const ids: Record<string, string> = {}
  on('tool.call', ($, e) => {
    ids[e.tool] = e.tool_use_id
    return e.tool === 'WebFetch' ? { isError: true, result: 'bad url', text: 'bad url' } : { ...OK, text: lines(7) }
  })
  return ids
}

test('compact cuts the header\'s input to 10 lines and shows 5 of output, inputs drops the output, none the input too, full restores the engine\'s; the description stays', async ($, on) => {
  const ids = session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const input = { command: lines(12), description: 'Count' }
  await $.tool.call({ tool: 'Bash', ...input })
  await $.tool.call({ tool: 'WebFetch', url: 'bad', prompt: 'p' })
  expect((await $.command.run(typed('compact'))).text).toBe('Tool rows show 10 lines of input and 5 of output.')
  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text?: string }>> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const use = await $.ui.mount({ ...row('Bash', input), requestId: ids.Bash, surface })
    expect(await texts(use)).toEqual([`Bash(${lines(10)}\n… +2 lines)`, '  ↳ ', 'Count'])
    const long = 'Fetch the npm publish dates for every recent version of the package and compare them'
    const short = await $.ui.mount({ ...row('Bash', { command: 'ls', description: long, timeout: 5 }), surface })
    expect(await texts(short)).toEqual(['Bash(ls)', '  ↳ ', long])
    const bare = await $.ui.mount({ ...row('TodoWrite', { todos: [] }), surface })
    expect(await texts(bare)).toEqual(['TodoWrite(…)'])
    const bash = await $.ui.mount({ ...result(ids.Bash ?? '', 'Bash', OK.result), surface })
    expect(await texts(bash)).toEqual(['  ⎿ line 1', '    line 2', '    line 3', '    line 4', '    line 5', '    … +2 lines'])
    const fetch = await $.ui.mount({ ...result(ids.WebFetch ?? '', 'WebFetch', 'bad url', true), surface })
    expect(await texts(fetch)).toEqual(['  ⎿ bad url'])
    const resumed = await $.ui.mount({ ...result('toolu_old', 'Bash', { stdout: '', stderr: '' }), surface })
    expect(await texts(resumed)).toEqual(['  ⎿ (no output)'])

    expect((await $.command.run(typed('inputs'))).text).toBe('Tool rows show their input, not their output.')
    expect(await texts(use)).toEqual([`Bash(${lines(12)})`, '  ↳ ', 'Count'])
    expect([await texts(bash), await texts(fetch)]).toEqual([[], []])
    expect((await $.command.run(typed('none'))).text).toBe('Tool rows show only the description.')
    expect(await texts(use)).toEqual(['Bash()', '  ↳ ', 'Count'])
    expect([await texts(bash), await texts(fetch)]).toEqual([[], []])
    expect((await $.command.run(typed('full'))).text).toBe('Tool rows show their full input and output.')
    expect(await texts(bash)).toEqual(['full output'])
    expect(await texts(use)).toEqual([`Bash(${lines(12)})`, '  ↳ ', 'Count'])
    await $.command.run(typed('compact'))
    for (const ui of [use, short, bare, bash, fetch, resumed]) await ui.unmount()
  }
  expect((await $.command.run(typed('x'))).text).toMatch(/^Unknown argument "x"/)
})

for (const [left, stored, drawn] of [
  ['inputs', { view: 'inputs' }, []],
  ['compact by 0.5.0', { compact: true }, ['  ⎿ hello']],
  ['nothing', {}, ['full output']],
] as const) {
  test(`a new session starts in the view it was left in: ${left}`, async ($, on) => {
    session(on, stored)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...result('toolu_old', 'Bash', { stdout: 'hello', stderr: '' }), surface: 'terminal' })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(drawn)
    await ui.unmount()
  })
}

const patch = (...lines: string[]) => [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines }]

test('calls that edit files count the lines they added and removed; others, and staged ones, count none', () => {
  expect(diffOf({ structuredPatch: patch(' a', '-b', '+c', '+d', '\\ No newline at end of file') })).toEqual({ added: 2, removed: 1 })
  expect(diffOf({ type: 'create', content: 'a\nb\nc\n', structuredPatch: [], originalFile: null })).toEqual({ added: 3, removed: 0 })
  expect(diffOf({ type: 'update', content: 'a', structuredPatch: [], originalFile: 'a' })).toEqual({ added: 0, removed: 0 })
  expect(diffOf({ type: 'update', content: 'a', structuredPatch: [], originalFile: null })).toBeUndefined()
  expect(diffOf({ structuredPatch: patch('+a'), staged: true })).toBeUndefined()
  const files = [{ filePath: '/a', hunks: patch('+x', '-y') }, { filePath: '/b', hunks: patch('+z'), created: true }]
  expect(diffOf({ stdout: '', stderr: '', bashEditDiff: { files, moreFiles: 0 } })).toEqual({ added: 2, removed: 1 })
  expect(diffOf({ stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, unavailable: true } })).toBeUndefined()
  expect([diffOf({ stdout: 'x', stderr: '' }), diffOf('File has not been read yet'), diffOf(undefined)]).toEqual([undefined, undefined, undefined])
})

test('an edit\'s row puts +added in green and -removed in red before its description, once it has run', async ($, on) => {
  mock.store(on)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tool}(…)</Text>
  })
  const input = { file_path: '/x/y.ts', old_string: 'b', new_string: 'c\nd' }
  for (const surface of ['terminal', 'desktop'] as const) {
    const done = await $.ui.mount({ ...row('Edit', input), props: { ...row('Edit', input).props, output: { structuredPatch: patch('-b', '+c', '+d') } }, surface })
    expect((await done.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Edit(…)', '  ↳ ', '+2', '/', '-1 ', '/x/y.ts'])
    expect((await done.find({ type: 'Text', text: '+2' }))?.props.color).toBe('success')
    expect((await done.find({ type: 'Text', text: '-1 ' }))?.props.color).toBe('error')
    const running = await $.ui.mount({ ...row('Edit', input), props: { ...row('Edit', input).props, isRunning: true }, surface })
    expect((await running.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Edit(…)', '  ↳ ', '/x/y.ts'])
    await done.unmount()
    await running.unmount()
  }
})

test('each row the session ran ends in its time, inside the description\'s button so the two wrap as one run, counting up while it runs and fixed once it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { gates, ids } = engine(on)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tool}(…)</Text>
  })
  expect([took(0), took(340), took(9_960), took(65_000)]).toEqual(['0.0s', '0.3s', '10.0s', '1m 5s'])
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = $.tool.call({ tool: 'Bash', command: 'sleep 3', description: 'Wait' })
  const todo = $.tool.call({ tool: 'TodoWrite', todos: [] })
  await clock.settle()
  const mount = (tool: string, input: unknown, i: number, isRunning: boolean) =>
    $.ui.mount({ ...row(tool, input), props: { ...row(tool, input).props, tool_use_id: ids[i] ?? '', isRunning }, surface: 'terminal' })
  const texts = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const live = await mount('Bash', { command: 'sleep 3', description: 'Wait' }, 0, true)
  expect(await texts(live)).toEqual(['Bash(…)', '  ↳ ', 'Wait', ' 0s'])
  await clock.advance(2_000)
  expect(await texts(live)).toEqual(['Bash(…)', '  ↳ ', 'Wait', ' 2s'])
  expect((await live.find({ type: 'Text', text: ' 2s' }))?.props.dimColor).toBe(true)
  expect((await live.find({ type: 'Button' }))?.text).toBe('Wait 2s')
  await clock.advance(1_400)
  gates[0]?.()
  gates[1]?.()
  await Promise.all([call, todo])
  const done = await mount('Bash', { command: 'sleep 3', description: 'Wait' }, 0, false)
  expect(await texts(done)).toEqual(['Bash(…)', '  ↳ ', 'Wait', ' 3.4s'])
  const bare = await mount('TodoWrite', { todos: [] }, 1, false)
  expect(await texts(bare)).toEqual(['TodoWrite(…)', '  ↳ ', '3.4s'])
  for (const ui of [live, done, bare]) await ui.unmount()
})

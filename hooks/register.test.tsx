import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { age, capped, firstWords, head, labelOf, storedText, toggled } from './register'

const SPINNER = {
  plugin: 'tool-status',
  component: 'Spinner',
  props: { word: '', message: null, suffix: '…', mode: 'tool-use' },
} as const

const OK = { result: { stdout: '', stderr: '', interrupted: false } }

// Stands for the engine beneath the plugin: draws the spinner's message (else
// its word), echoes turns, and holds every tool call until its gate opens.
function engine(on: On) {
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.message ?? e.props.word}</Text>
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const gates: Array<() => void> = []
  let calls = 0
  on('tool.call', async () => {
    calls += 1
    await new Promise<void>(r => gates.push(r))
    return OK
  })
  return { gates, calls: () => calls }
}

test('labels: a Bash description alone, any other call by tool and its main field', () => {
  expect(labelOf('Bash', { command: 'ls', description: 'List files' })).toBe('List files')
  expect(labelOf('Bash', { command: 'ls' })).toBe('Bash ls')
  expect(labelOf('Read', { file_path: '/x/y.ts' })).toBe('Read /x/y.ts')
  expect(labelOf('Agent', { description: 'Find docs', prompt: 'long…' })).toBe('Agent Find docs')
  expect(labelOf('TodoWrite', { todos: [] })).toBe('TodoWrite')
  expect([age(0), age(59_999), age(65_000), age(3_725_000)]).toEqual(['0s', '59s', '1m 5s', '1h 2m'])
  expect(firstWords('List files')).toBe('List files')
  expect(firstWords('Fetch npm publish dates for recent versions')).toBe('Fetch npm publish')
  expect(firstWords('Read /home/user/.claude/settings.json')).toBe('Read /home/user/.claude/settings')
})

test('the spinner shows running calls, then the last one with its age, ticking until the turn ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { gates } = engine(on)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const text = async () => (await ui.find({ type: 'Text' }))?.text
  expect(await text()).toBe('')

  await $.turn.start({ text: 'hi', turnId: 't1' })
  const bash = $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files in the home directory' })
  const read = $.tool.call({ tool: 'Read', file_path: '/x/y.ts' })
  await clock.settle()
  expect(await text()).toBe('Read /x/y.ts (+1 more)')

  gates[1]?.()
  await read
  expect(await text()).toBe('List files in the home directory')
  gates[0]?.()
  await bash
  expect(await text()).toBe('0s ago · List files in')

  await clock.advance(65_000)
  expect(await text()).toBe('1m 5s ago · List files in')

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10_000)
  expect(await text()).toBe('1m 5s ago · List files in')
  await ui.unmount()
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

test('every tool row carries what its call was doing in a dim line under the header', async ($, on) => {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tool}(…)</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [tool, input, shown] of [
      ['Bash', { command: 'ls', description: 'List files' }, '  ↳ List files'],
      ['Read', { file_path: '/x/y.ts' }, '  ↳ /x/y.ts'],
      ['TodoWrite', { todos: [] }, undefined],
    ] as const) {
      const ui = await $.ui.mount({ ...row(tool, input), surface })
      expect(await ui.find({ type: 'Text', text: `${tool}(…)` })).toBeDefined()
      const line = await ui.find({ type: 'Text', text: /↳/ })
      expect(line?.text).toBe(shown)
      if (line) expect(line.props.dimColor).toBe(true)
      await ui.unmount()
    }
  }
})

const result = (id: string, tool: string, output: unknown, isErrored = false) => ({
  plugin: 'tool-status',
  component: 'ToolResult',
  requestId: id,
  props: { tool_use_id: id, tool, output, isErrored },
} as const)

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

test('/tool-output alone flips; full and compact set; heads keep the first lines and count the rest', () => {
  expect([toggled('', false), toggled(' ', true), toggled('compact', false), toggled('FULL', true)]).toEqual([true, false, true, false])
  expect(toggled('on', true)).toBe(null)
  expect(head(lines(7), 5)).toEqual({ lines: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'], more: 2 })
  expect(head('one\n\n', 5)).toEqual({ lines: ['one'], more: 0 })
  expect(head('  \n', 5)).toEqual({ lines: [], more: 0 })
  expect(capped({ command: 'a\nb\nc', description: 'x', timeout: 5 }, 2)).toEqual({ command: 'a\nb\n… +1 lines', description: 'x', timeout: 5 })
  expect([storedText('text'), storedText({ stdout: 'out', stderr: 'err' }), storedText({ file: {} })]).toEqual(['text', 'out\nerr', undefined])
})

function session(on: On, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
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
    return e.tool === 'Grep' ? { isError: true, result: 'bad regex', text: 'bad regex' } : { ...OK, text: lines(7) }
  })
  return ids
}

test('compact rows cut the header\'s input to 10 lines, show the description whole and 5 lines of output, errors alike, and /tool-output full restores the engine\'s', async ($, on) => {
  const ids = session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const input = { command: lines(12), description: 'Count' }
  await $.tool.call({ tool: 'Bash', ...input })
  await $.tool.call({ tool: 'Grep', pattern: '(' })
  expect((await $.command.run({ command: 'tool-output', args: '' })).text).toBe('Tool rows are compact.')
  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text?: string }>> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const use = await $.ui.mount({ ...row('Bash', input), requestId: ids.Bash, surface })
    expect(await texts(use)).toEqual([`Bash(${lines(10)}\n… +2 lines)`, '  ↳ Count'])
    const long = 'Fetch the npm publish dates for every recent version of the package and compare them'
    const short = await $.ui.mount({ ...row('Bash', { command: 'ls', description: long, timeout: 5 }), surface })
    expect(await texts(short)).toEqual(['Bash(ls)', `  ↳ ${long}`])
    const bare = await $.ui.mount({ ...row('TodoWrite', { todos: [] }), surface })
    expect(await texts(bare)).toEqual(['TodoWrite(…)'])
    const bash = await $.ui.mount({ ...result(ids.Bash ?? '', 'Bash', OK.result), surface })
    expect(await texts(bash)).toEqual(['  ⎿ line 1', '    line 2', '    line 3', '    line 4', '    line 5', '    … +2 lines'])
    const grep = await $.ui.mount({ ...result(ids.Grep ?? '', 'Grep', 'bad regex', true), surface })
    expect(await texts(grep)).toEqual(['  ⎿ bad regex'])
    const resumed = await $.ui.mount({ ...result('toolu_old', 'Bash', { stdout: '', stderr: '' }), surface })
    expect(await texts(resumed)).toEqual(['  ⎿ (no output)'])

    expect((await $.command.run({ command: 'tool-output', args: 'full' })).text).toBe('Tool rows show their full output.')
    expect(await texts(bash)).toEqual(['full output'])
    expect(await texts(use)).toEqual([`Bash(${lines(12)})`, '  ↳ Count'])
    await $.command.run({ command: 'tool-output', args: 'compact' })
    for (const ui of [use, short, bare, bash, grep, resumed]) await ui.unmount()
  }
  expect((await $.command.run({ command: 'tool-output', args: 'x' })).text).toMatch(/^Unknown argument "x"/)
})

test('a new session starts compact when it was left compact', async ($, on) => {
  session(on, { compact: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...result('toolu_old', 'Bash', { stdout: 'hello', stderr: '' }), surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['  ⎿ hello'])
  await ui.unmount()
})

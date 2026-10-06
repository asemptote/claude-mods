import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { age, firstWords, labelOf } from './register'

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

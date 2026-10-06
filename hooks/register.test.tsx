import { test, expect } from 'claude-code/testing'

const SPINNER = {
  plugin: 'bash-status',
  component: 'Spinner',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
} as const

const OK = { result: { stdout: '', stderr: '', interrupted: false } }

test('the spinner shows the description while the command runs, then its own word', async ($, on) => {
  // Stands for the engine's spinner: draws the message, else the word.
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.message ?? e.props.word}</Text>
  })
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  // All three calls reach here only after the plugin has recorded them.
  let arrived = 0
  let allArrived!: () => void
  const inFlight = new Promise<void>(r => { allArrived = r })
  on('tool.call', { tool: 'Bash' }, async () => {
    if (++arrived === 3) allArrived()
    await gate
    return OK
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...SPINNER, surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Sauteing')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const slow = $.tool.call({ tool: 'Bash', command: 'slow', description: 'Slow one' })
  const other = $.tool.call({ tool: 'Bash', command: 'other', description: 'Other one' })
  const bare = $.tool.call({ tool: 'Bash', command: 'bare' })
  await inFlight
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Other one (+1 more)')
  release()
  await Promise.all([slow, other, bare])
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Sauteing')
  await ui.unmount()
})

const row = (input: unknown, tool = 'Bash') => ({
  plugin: 'bash-status',
  component: 'ToolUse',
  props: { tool_use_id: 'toolu_1', tool, input, isRunning: false, isErrored: false, isInterrupted: false },
} as const)

test('a Bash row carries its description in a dim line under the header', async ($, on) => {
  // Stands for the engine's row header.
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tool}(…)</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...row({ command: 'ls', description: 'List files' }), surface })
    expect((await ui.find({ type: 'Text', text: 'Bash(…)' }))).toBeDefined()
    const line = await ui.find({ type: 'Text', text: /List files/ })
    expect(line?.text).toBe('  ↳ List files')
    expect(line?.props.dimColor).toBe(true)
    await ui.unmount()

    for (const bare of [row({ command: 'ls' }), row({ file_path: '/x', description: 'Not Bash' }, 'Read')]) {
      const plain = await $.ui.mount({ ...bare, surface })
      expect(await plain.find({ type: 'Text', text: /↳/ })).toBeUndefined()
      await plain.unmount()
    }
  }
})

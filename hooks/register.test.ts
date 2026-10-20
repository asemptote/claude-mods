import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SPINNER = {
  plugin: 'spinner-detail',
  surface: 'terminal',
  component: 'Spinner',
  props: { word: 'Sauteing', message: null, suffix: '...', mode: 'tool-use' },
} as const

const BASH_RESULT = { result: { stdout: '', stderr: '', interrupted: false } }

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const BASH_CALL = { tool: 'Bash', command: 'ls', description: 'List files' } as const

const ENGINE_DRAWING = { type: 'engine', ref: 0 } as const

const EDIT_OUTPUT = {
  filePath: '/work/a.txt',
  structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }],
}

const answerEngine = (on: On) => {
  const spinner: { message: string | null; input?: unknown; output?: unknown } = { message: null }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    spinner.message = e.props.message
    return ENGINE_DRAWING
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    spinner.input = e.props.input
    return ENGINE_DRAWING
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    spinner.output = e.props.output
    return ENGINE_DRAWING
  })
  return spinner
}

const toolRow = (requestId: string) =>
  ({
    plugin: 'spinner-detail',
    surface: 'terminal',
    component: 'ToolUse',
    requestId,
    props: {
      tool_use_id: requestId,
      tool: 'Bash',
      input: { command: 'ls' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  }) as const

const toolResult = (requestId: string, isErrored: boolean, output: unknown = BASH_RESULT.result) =>
  ({
    plugin: 'spinner-detail',
    surface: 'terminal',
    component: 'ToolResult',
    requestId,
    props: { tool_use_id: requestId, tool: 'Bash', output, isErrored },
  }) as const

test('the spinner follows the call, then counts up from when it finished', async ($, on) => {
  mock.env(on, { CLAUDE_JOB_DIR: '/job' })
  const clock = mock.clock(on)
  const job = { state: 'working', detail: 'previous step' }
  on('fs.read', () => ({ value: JSON.stringify(job) }))
  const spinner = answerEngine(on)

  const seen: (string | null)[] = []
  const draw = async () => {
    const ui = await $.ui.mount(SPINNER)
    await ui.unmount()
    seen.push(spinner.message)
  }

  on('tool.call', { tool: 'Bash' }, async () => {
    await draw()
    await clock.advance(1000)
    await draw()
    job.detail = 'Listing the files'
    await clock.advance(1000)
    await draw()
    return BASH_RESULT
  })

  await $.session.start(START)
  await $.tool.call(BASH_CALL)
  await draw()
  await clock.advance(3000)
  await draw()
  Object.assign(job, { state: 'done', detail: 'the next prompt' })
  await clock.advance(62000)
  await draw()

  expect(seen).toEqual([
    'List files',
    'List files',
    'Listing the files',
    'Listing the files (2.0s, 0s ago)',
    'Listing the files (2.0s, 3s ago)',
    'Listing the files (2.0s, 1m 5s ago)',
  ])
})

test('outside a job the description is shown, then counted from its finish', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  const spinner = answerEngine(on)

  const seen: (string | null)[] = []
  const draw = async () => {
    const ui = await $.ui.mount(SPINNER)
    await ui.unmount()
    seen.push(spinner.message)
  }

  on('tool.call', { tool: 'Bash' }, async () => {
    await draw()
    return BASH_RESULT
  })

  await $.session.start(START)
  await $.tool.call(BASH_CALL)
  await clock.advance(2000)
  await draw()

  expect(seen).toEqual(['List files', 'List files (0.0s, 2s ago)'])
})

test('each tool row carries its line, the latest one counting up', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  answerEngine(on)

  const ids: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ids.push(e.tool_use_id)
    return BASH_RESULT
  })

  const rowLine = async (requestId: string) => {
    const ui = await $.ui.mount(toolRow(requestId))
    const drawn = await ui.drawn()
    await ui.unmount()
    return JSON.stringify(drawn)
  }

  await $.session.start(START)
  await $.tool.call(BASH_CALL)
  await clock.advance(4000)
  expect(await rowLine(ids[0])).toContain('List files (0.0s, 4s ago)')

  await $.tool.call({ ...BASH_CALL, description: 'Count lines' })
  await clock.advance(1000)
  const firstRow = await rowLine(ids[0])
  expect(firstRow).toContain('List files (0.0s, then 4.0s)')
  expect(firstRow).not.toContain('ago')
  expect(await rowLine(ids[1])).toContain('Count lines (0.0s, 1s ago)')
  expect(await rowLine('unrelated')).toBe(JSON.stringify(ENGINE_DRAWING))
})

test('a command moved to the background is marked as such', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  answerEngine(on)

  const ids: string[] = []
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    ids.push(e.tool_use_id)
    await clock.advance(2000)
    return { result: { ...BASH_RESULT.result, backgroundTaskId: 'b1', timedOutAfterMs: 2000 } }
  })

  await $.session.start(START)
  await $.tool.call(BASH_CALL)
  await $.tool.call({ ...BASH_CALL, description: 'Count lines' })

  const ui = await $.ui.mount(toolRow(ids[0]))
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  expect(drawn).toContain('List files (2.0s, then 0.0s, backgrounded)')
})

test('the end of the turn stops the count, and a call still running when the next starts has none', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('turn.complete', () => ({ text: '' }))
  answerEngine(on)

  const ids: string[] = []
  let releaseSlow = () => {}
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ids.push(e.tool_use_id)
    if (e.description !== 'Slow') return BASH_RESULT
    return new Promise<typeof BASH_RESULT>(resolve => {
      releaseSlow = () => resolve(BASH_RESULT)
    })
  })

  const rowLine = async (requestId: string) => {
    const ui = await $.ui.mount(toolRow(requestId))
    const drawn = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return drawn
  }

  await $.session.start(START)
  const slow = $.tool.call({ ...BASH_CALL, description: 'Slow' })
  await clock.advance(1000)
  await $.tool.call(BASH_CALL)
  await clock.advance(1000)
  releaseSlow()
  await slow
  expect(await rowLine(ids[0])).toContain('Slow (2.0s)')

  await clock.advance(3000)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 5000, isAborted: false })
  await clock.advance(60000)
  const lastRow = await rowLine(ids[1])
  expect(lastRow).toContain('List files (0.0s, then 4.0s)')
  expect(lastRow).not.toContain('ago')
})

test('a job whose state is written after the session starts still shows its detail', async ($, on) => {
  mock.env(on, { CLAUDE_JOB_DIR: '/job' })
  const clock = mock.clock(on)
  let job: { state: string; detail: string } | undefined
  on('fs.read', () => (job ? { value: JSON.stringify(job) } : { deny: 'missing' }))
  const spinner = answerEngine(on)

  on('tool.call', { tool: 'Bash' }, async () => {
    job = { state: 'working', detail: 'Listing the files' }
    await clock.advance(1000)
    return BASH_RESULT
  })

  await $.session.start(START)
  await $.tool.call(BASH_CALL)
  const ui = await $.ui.mount(SPINNER)
  await ui.unmount()
  expect(spinner.message).toBe('Listing the files (1.0s, 0s ago)')
})

test('a Bash call without a description is refused before it runs', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  answerEngine(on)

  let ran = 0
  on('tool.call', { tool: 'Bash' }, () => {
    ran += 1
    return BASH_RESULT
  })

  await $.session.start(START)
  const refused = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const blank = await $.tool.call({ ...BASH_CALL, description: '  ' })
  await $.tool.call(BASH_CALL)
  expect(refused).toMatchObject({ deny: expect.stringContaining('description') })
  expect(blank).toMatchObject({ deny: expect.stringContaining('description') })
  expect(ran).toBe(1)
})

test('tool calls show only their descriptions until /tool-detail, which cycles through the other details', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  const engine = answerEngine(on)

  const ids: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ids.push(e.tool_use_id)
    return BASH_RESULT
  })

  const drawn = async (site: Parameters<typeof $.ui.mount>[0]) => {
    const ui = await $.ui.mount(site)
    const tree = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return tree
  }

  const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix} ${index}`)
  const commandLines = numbered('line', 12)
  const longCommand = commandLines.join('\n')
  const previewedCommand = [...commandLines.slice(0, 10), '... +2 lines'].join('\n')
  const longRow = (requestId: string) => {
    const row = toolRow(requestId)
    return { ...row, props: { ...row.props, input: { command: longCommand } } }
  }
  const longOutput = { ...BASH_RESULT.result, stdout: numbered('out', 3).join('\n'), stderr: numbered('err', 4).join('\n') }
  const previewedOutput = { ...longOutput, stderr: ['err 0', 'err 1', '... +2 lines'].join('\n') }
  const errorText = numbered('error', 8).join('\n')

  await $.session.start(START)
  await $.tool.call(BASH_CALL)

  expect(await drawn(longRow(ids[0]))).not.toContain('engine')
  expect(await $.command.run({ command: 'tool-detail', args: 'preview' })).toMatchObject({ text: expect.stringContaining('first 10') })
  const row = await drawn(longRow(ids[0]))
  expect(row).toContain('List files (0.0s, 0s ago)')
  expect(engine.input).toEqual({ command: previewedCommand })
  await drawn(toolRow(ids[0]))
  expect(engine.input).toEqual({ command: 'ls' })
  expect(await drawn(toolResult(ids[0], false, longOutput))).toBe(JSON.stringify(ENGINE_DRAWING))
  expect(engine.output).toEqual(previewedOutput)
  await drawn(toolResult(ids[0], false))
  expect(engine.output).toEqual(BASH_RESULT.result)
  const errored = await drawn(toolResult(ids[0], true, errorText))
  expect(errored).toContain('error 4')
  expect(errored).toContain('... +3 lines')
  expect(errored).not.toContain('error 5')
  expect(await drawn(toolResult(ids[0], true))).toBe(JSON.stringify(ENGINE_DRAWING))

  const grepRow = toolRow('grep')
  await drawn({ ...grepRow, props: { ...grepRow.props, tool: 'Grep', input: { pattern: longCommand }, output: longOutput } })
  expect(engine.input).toEqual({ pattern: previewedCommand })
  const grepResult = toolResult('grep', false, { mode: 'content', content: errorText })
  await drawn({ ...grepResult, props: { ...grepResult.props, tool: 'Grep' } })
  expect(engine.output).toEqual({ mode: 'content', content: [...numbered('error', 5), '... +3 lines'].join('\n') })

  const diffResult = (tool: string, output: unknown) => {
    const result = toolResult('diff', false, output)
    return { ...result, props: { ...result.props, tool } }
  }
  const edited = await drawn(
    diffResult('Edit', {
      filePath: '/work/a.txt',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }],
    }),
  )
  expect(edited).toContain('+2')
  expect(edited).toContain('-1')
  expect(edited).not.toContain('engine')
  const created = await drawn(diffResult('Write', { type: 'create', content: 'a\nb\nc\n', structuredPatch: [] }))
  expect(created).toContain('+3')
  expect(created).toContain('-0')

  expect(await $.command.run({ command: 'tool-detail', args: 'input-only' })).toMatchObject({ text: expect.stringContaining('no output') })
  const inputOnlyRow = longRow(ids[0])
  const inputOnly = await drawn({ ...inputOnlyRow, props: { ...inputOnlyRow.props, output: longOutput } })
  expect(inputOnly).toContain('List files')
  expect(engine.input).toEqual({ command: previewedCommand })
  const hiddenResult = await drawn(toolResult(ids[0], false, longOutput))
  expect(hiddenResult).not.toContain('engine')
  expect(hiddenResult).not.toContain('out 0')

  expect(await $.command.run({ command: 'tool-detail', args: 'none' })).toMatchObject({ text: expect.stringContaining('only their descriptions') })
  engine.input = undefined
  const described = await drawn(longRow(ids[0]))
  expect(described).toContain('List files')
  expect(described).not.toContain('engine')
  expect(engine.input).toBeUndefined()
  expect(await drawn(toolResult(ids[0], false, longOutput))).not.toContain('engine')
  await drawn(longRow('undescribed'))
  expect(engine.input).toEqual({ command: previewedCommand })

  expect(await $.command.run({ command: 'tool-detail', args: 'full' })).toMatchObject({ text: 'Tool calls are shown in full.' })
  await drawn(longRow(ids[0]))
  expect(engine.input).toEqual({ command: longCommand })
  await drawn(toolResult(ids[0], false, longOutput))
  expect(engine.output).toEqual(longOutput)
  expect(await drawn(toolResult(ids[0], true, errorText))).toBe(JSON.stringify(ENGINE_DRAWING))
  expect(await drawn(diffResult('Edit', { structuredPatch: [] }))).toBe(JSON.stringify(ENGINE_DRAWING))

  expect(await $.command.run({ command: 'tool-detail', args: 'preview' })).toMatchObject({ text: expect.stringContaining('first 10') })
  await drawn(longRow(ids[0]))
  expect(engine.input).toEqual({ command: previewedCommand })
  await drawn(toolResult(ids[0], false, longOutput))
  expect(engine.output).toEqual(previewedOutput)

  expect(await $.command.run({ command: 'tool-detail', args: ' none ' })).toMatchObject({ text: expect.stringContaining('only their descriptions') })
  expect(await $.command.run({ command: 'tool-detail', args: 'some' })).toMatchObject({ text: expect.stringContaining('Unknown tool detail') })
  expect(await $.command.run({ command: 'tool-detail', args: 'full' })).toMatchObject({ text: 'Tool calls are shown in full.' })
})

test('a call with a diff carries its counts in its description, not in its result', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  answerEngine(on)
  const ids: string[] = []
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    ids.push(e.tool_use_id)
    return { result: EDIT_OUTPUT }
  })

  const drawn = async (site: Parameters<typeof $.ui.mount>[0]) => {
    const ui = await $.ui.mount(site)
    const tree = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return tree
  }

  await $.session.start(START)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.txt', old_string: 'old', new_string: 'new\nmore' })
  const row = toolRow(ids[0])
  const editRow = { ...row, props: { ...row.props, tool: 'Edit', input: {}, output: EDIT_OUTPUT } }
  const described = await drawn(editRow)
  expect(described).toContain('Edit (0.0s')
  expect(described).toContain('+2')
  expect(described).toContain('-1')
  expect(await drawn({ ...editRow, props: { ...editRow.props, isErrored: true } })).not.toContain('+2')

  await $.command.run({ command: 'tool-detail', args: 'preview' })
  expect(await drawn(editRow)).toContain('+2')
  const result = toolResult(ids[0], false, EDIT_OUTPUT)
  expect(await drawn({ ...result, props: { ...result.props, tool: 'Edit' } })).not.toContain('+2')
})

test('a clicked description cycles its own call, backwards under ctrl or the right button, and /tool-detail cycles them all', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  answerEngine(on)
  const ids: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ids.push(e.tool_use_id)
    return BASH_RESULT
  })
  const drawn = async (site: Parameters<typeof $.ui.mount>[0]) => {
    const ui = await $.ui.mount(site)
    const tree = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return tree
  }
  const click = async (requestId: string, modifiers: { ctrl?: true; button?: 'right' } = {}) => {
    const ui = await $.ui.mount(toolRow(requestId))
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', ...modifiers })
    await ui.unmount()
  }

  await $.session.start(START)
  await $.tool.call(BASH_CALL)
  await $.tool.call(BASH_CALL)
  expect(await drawn(toolRow(ids[0]))).toContain('hooks/description.tsx')

  await click(ids[0])
  expect(await drawn(toolRow(ids[0]))).toContain('engine')
  expect(await drawn(toolResult(ids[0], false))).not.toContain('engine')
  expect(await drawn(toolRow(ids[1]))).not.toContain('engine')

  await click(ids[1], { ctrl: true })
  expect(await drawn(toolResult(ids[1], false))).toContain('engine')
  await click(ids[1], { button: 'right' })
  await click(ids[1], { ctrl: true })
  expect(await drawn(toolRow(ids[1]))).toContain('engine')
  expect(await drawn(toolResult(ids[1], false))).not.toContain('engine')

  await $.command.run({ command: 'tool-detail', args: 'none' })
  expect(await drawn(toolRow(ids[0]))).not.toContain('engine')
  expect(await drawn(toolRow(ids[1]))).not.toContain('engine')

  const ui = await $.ui.mount({ ...toolRow(ids[0]), surface: 'mobile' })
  await ui.press({ key: `detail-${ids[0]}` })
  await ui.unmount()
  expect(await drawn(toolResult(ids[0], false))).not.toContain('engine')
  expect(await drawn(toolRow(ids[1]))).not.toContain('engine')

  await $.command.run({ command: 'tool-detail', args: 'full' })
  expect(await drawn(toolRow(ids[1]))).toContain('engine')
  expect(await $.command.run({ command: 'tool-detail', args: '' })).toMatchObject({ text: expect.stringContaining('only their descriptions') })
  expect(await $.command.run({ command: 'tool-detail', args: '' })).toMatchObject({ text: expect.stringContaining('no output') })
})

test('a description is inverted while the pointer is over it', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  mock.clock(on)
  on('session.id', () => ({ value: '01234567-89ab' }))
  on('fs.read', () => ({ deny: 'missing' }))
  answerEngine(on)
  const ids: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ids.push(e.tool_use_id)
    return BASH_RESULT
  })

  await $.session.start(START)
  await $.tool.call(BASH_CALL)
  const ui = await $.ui.mount(toolRow(ids[0]))
  const scope = { in: `detail-${ids[0]}` }
  expect(JSON.stringify(await ui.drawn(scope))).not.toContain('"inverse":true')
  await ui.pointer({ type: 'enter', x: 2, y: 0 })
  expect(JSON.stringify(await ui.drawn(scope))).toContain('"inverse":true')
  await ui.pointer({ type: 'leave', x: 2, y: 0 })
  expect(JSON.stringify(await ui.drawn(scope))).not.toContain('"inverse":true')
  await ui.unmount()
})

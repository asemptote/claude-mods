import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Running } from '../types'

// The Bash calls in flight, oldest first. Parallel calls share the one spinner
// line, so it shows the newest and counts the rest.
const running = atom({ plugin: 'bash-status', key: 'running' } as const, [] as Running[])

function line(all: Running[]): string | undefined {
  const newest = all.at(-1)
  if (newest === undefined) return undefined
  return all.length > 1 ? `${newest.description} (+${all.length - 1} more)` : newest.description
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const { description } = e
    if (!description) return next(e)
    await update($, running, all => [...all, { id: e.tool_use_id, description }])
    try {
      return await next(e)
    } finally {
      await update($, running, all => all.filter(r => r.id !== e.tool_use_id))
    }
  })
    // A failure here must never cost the call: hand back what lies beneath.
    .catch(($, e, next) => next(e))

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const message = line(await read($, running))
    return next(message === undefined ? e : { ...e, props: { ...e.props, message } })
  })

  // Keeps the description on the command's own transcript row, dim, under its
  // header. Rows folded into a group's count line are not drawn one by one.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    const input = e.props.input as { description?: unknown } | null
    const description = e.props.tool === 'Bash' ? input?.description : undefined
    if (typeof description !== 'string' || description === '') return row
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        <Text dimColor>  ↳ {description}</Text>
      </Box>
    )
  })
}

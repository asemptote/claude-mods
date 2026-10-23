import type { ClientModule } from 'claude-code'

import type { LineProps } from '../types'

// A tool row's line, drawn as a region of its own so a click says which button
// pressed it: left steps the row's detail forward, right or ctrl+left back,
// posted to the hooks module, which stores it. Inverted while the pointer is
// over it, as a Button is: every enter and leave sets it, since both can come
// in one frame, before the redraw that would renew `isHovered` here. One outer
// Text, so a long line wraps as one run.
const Line: ClientModule<LineProps, boolean> = ({ runs }, surface) => {
  const isHovered = surface.state === true
  surface.onPointer(event => {
    if (event.type === 'enter' || event.type === 'leave') surface.setState(event.type === 'enter')
    else if (event.type === 'down') {
      if (event.button === 'right' || (event.button === 'left' && event.ctrl)) surface.post({ step: -1 })
      else if (event.button === 'left') surface.post({ step: 1 })
    }
  })
  const { Text } = surface.elements
  return (
    <Text>
      {runs.map((run, i) => (
        <Text key={String(i)} color={run.color ?? undefined} dimColor={run.dim} inverse={isHovered}>
          {run.text}
        </Text>
      ))}
    </Text>
  )
}

export default Line

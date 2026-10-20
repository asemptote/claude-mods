import type { ClientModule } from 'claude-code'

import type { DetailLineProps } from '../types'

// A tool row's summary line, drawn as a region of its own so a click says
// which button pressed it: left steps the detail forward, right or ctrl+left
// back, posted to the hooks module, which stores it. Inverted while the
// pointer is over it, as a Button is.
const DetailLine: ClientModule<DetailLineProps, boolean> = ({ runs }, surface) => {
  const isHovered = surface.state === true
  surface.onPointer(event => {
    if (event.type === 'enter' || event.type === 'leave') {
      const hovered = event.type === 'enter'
      if (hovered !== isHovered) surface.setState(hovered)
    } else if (event.type === 'down') {
      if (event.button === 'right' || (event.button === 'left' && event.ctrl)) surface.post({ step: -1 })
      else if (event.button === 'left') surface.post({ step: 1 })
    }
  })
  const { Box, Text } = surface.elements
  return (
    <Box>
      {runs.map((run, i) => (
        <Text key={String(i)} color={run.color} inverse={isHovered}>
          {run.text}
        </Text>
      ))}
    </Box>
  )
}

export default DetailLine

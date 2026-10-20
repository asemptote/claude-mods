import type { ClientModule, Color } from 'claude-code'

export type Segment = { text: string; color: Color | null }

const Description: ClientModule<{ segments: Segment[] }, boolean> = (props, surface) => {
  surface.onPointer(event => {
    if (event.type === 'enter' || event.type === 'leave') surface.setState(event.type === 'enter')
    if (event.type !== 'down') return
    if (event.button === 'left') surface.post({ step: event.ctrl ? -1 : 1 })
    if (event.button === 'right') surface.post({ step: -1 })
  })
  const { Text } = surface.elements
  return (
    <Text>
      {props.segments.map(segment => (
        <Text color={segment.color ?? undefined} inverse={surface.state === true}>
          {segment.text}
        </Text>
      ))}
    </Text>
  )
}

export default Description

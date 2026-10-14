export type Running = { id: string; label: string }
export type Finished = { label: string; endedAt: number }
// The first lines of a text, and how many lines follow them.
export type Head = { lines: string[]; more: number }
// How much of each call a tool row shows, least first.
export type View = 'none' | 'compact' | 'inputs' | 'full'

declare module 'claude-code' {
  interface PluginState {
    'tool-status': { running: Running[]; last: Finished | null; now: number; view: View; outputs: StateFamily<Head | null> }
  }
}

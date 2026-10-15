// `label` is the spinner's text, the tool's name; `detail` goes on the line under
// it. `label` keeps its name so a full label an older load left in $.state still draws.
export type Running = { id: string; label: string; detail?: string }
// `ms`, how long it ran, is absent from a value an older load left.
export type Finished = { label: string; detail?: string; endedAt: number; ms?: number }
// The first lines of a text, and how many lines follow them.
export type Head = { lines: string[]; more: number }
// The lines a call added to and removed from files.
export type Diff = { added: number; removed: number }
// When a call started, in the clock's ms, and how long it ran once it ended.
export type Timing = { startedAt: number; ms?: number }
// How much of each call a tool row shows, least first.
export type View = 'none' | 'compact' | 'inputs' | 'full'

declare module 'claude-code' {
  interface PluginState {
    'tool-status': { running: Running[]; last: Finished | null; now: number; view: View; outputs: StateFamily<Head | null>; timings: StateFamily<Timing | null> }
  }
}

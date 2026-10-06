export type Running = { id: string; label: string }
export type Finished = { label: string; endedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-status': { running: Running[]; last: Finished | null; now: number }
  }
}

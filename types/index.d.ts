export type Shown = string | null
export type Detail = 'preview' | 'input-only' | 'none' | 'full'
export type Choice = { detail: Detail; generation: number } | null

declare module 'claude-code' {
  interface PluginState {
    'spinner-detail': {
      shown: Shown
      lines: StateFamily<string>
      detail: Detail
      generation: number
      chosen: StateFamily<Choice>
    }
  }
}

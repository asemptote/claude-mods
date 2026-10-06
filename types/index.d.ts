export type Running = { id: string; description: string }

declare module 'claude-code' {
  interface PluginState {
    'bash-status': { running: Running[] }
  }
}

export type RunningCall = { id: string; description: string; startedAt: number }
export type FinishedCall = { description: string; endedAt: number; isErrored: boolean }
export type LoopActivity = { running: RunningCall[]; last: FinishedCall | null }
export type ToolDetail = 'none' | 'compact' | 'input' | 'full'
/** A click's choice for one row, standing while `epoch` is unchanged. */
export type RowView = { detail: ToolDetail; epoch: number }
export type CallRecord = { description: string; startedAt: number; endedAt: number | null; isErrored: boolean }

declare module 'claude-code' {
  interface PluginState {
    'spinner-tool-desc': {
      /** Per loop: `main`, or a subagent's id. */
      loops: Record<string, LoopActivity>
      /** The clock as last ticked, so spinners redraw their elapsed times. */
      now: number
      /** `/transcript-tool-detail`: how much of each tool call its row draws. */
      detail: ToolDetail
      /** Bumped by each `/transcript-tool-detail`, so earlier clicks lapse. */
      epoch: number
      /** Per tool call, by its tool_use_id: the detail a click on its row chose. */
      views: StateFamily<RowView>
      /** Per tool call, by its tool_use_id: what its transcript row reads. */
      calls: StateFamily<CallRecord>
    }
  }
}

/** One colored run of a tool row's summary line. */
export type DetailRun = { text: string; color: 'claude' | 'green' | 'red' }
/** What the summary line's `Client` draws. */
export type DetailLineProps = { runs: DetailRun[] }

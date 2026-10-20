/** How much of a tool call its transcript row draws, least first. */
export type Detail = 'none' | 'compact' | 'input' | 'full'

/** A call in flight, as its loop's spinner names it. */
export type RunningCall = { id: string; label: string; detail: string | null; startedAt: number }
/** The call a loop finished last, which its spinner names while nothing runs. */
export type FinishedCall = {
  label: string
  detail: string | null
  endedAt: number
  ms: number
  isErrored: boolean
  isBackgrounded: boolean
}
export type LoopActivity = { running: RunningCall[]; last: FinishedCall | null }

/** A click's choice for one row, standing while `epoch` is unchanged. */
export type RowView = { detail: Detail; epoch: number }
/** What a row knows of its call that the row's props do not. */
export type CallRecord = { startedAt: number; endedAt: number | null; isErrored: boolean; isBackgrounded: boolean }

declare module 'claude-code' {
  interface PluginState {
    'tool-status': {
      /** Per loop: `main`, or a subagent's id. */
      loops: Record<string, LoopActivity>
      /** The clock as last ticked, so spinners and running rows redraw their times. */
      now: number
      /** `/tool-detail`'s choice, every row's unless a click chose another. */
      detail: Detail
      /** Bumped by each `/tool-detail`, so earlier clicks lapse. */
      epoch: number
      /** Per tool call, by its tool_use_id. */
      views: StateFamily<RowView>
      /** Per tool call, by its tool_use_id. */
      calls: StateFamily<CallRecord>
    }
  }
}

/** One run of a row's line, as `Text` draws it. */
export type Run = { text: string; color: 'claude' | 'success' | 'error' | null; dim: boolean }
/** What the line's `Client` draws. */
export type LineProps = { runs: Run[] }

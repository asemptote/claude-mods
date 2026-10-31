// A shell command split into the pieces a highlighter draws: the shell itself,
// and the code it hands another language (a bash heredoc's body, a PowerShell
// here-string, a multi-line `-c`/`-e` argument), each with the language it is
// in. Shell code handed to a shell (`bash -c '…'`, `ssh host <<EOF`, `pwsh
// -c "…"`) is split again by that shell's rules, so code inside it is found
// too. No `$`, so the tests call it directly.
//
// It reads a command the way a highlighter needs, not as the shell runs it:
// what it cannot place stays shell, which is how the whole command would draw.

/** The shells whose commands split: Bash's and PowerShell's. */
export type Shell = 'bash' | 'powershell'

/** One block of a command, drawn by `Code` on rows of its own. */
export type Segment = {
  text: string
  /** A highlighter language id; absent with `path`, and for plain text. */
  language?: string
  /** A file name the language is inferred from (a heredoc written to `x.py`). */
  path?: string
}

const MAX_DEPTH = 4

/**
 * A program that reads code: the language, the flags whose argument is code
 * (lower case), and, for one whose code is a positional argument, how many
 * positional arguments come before it (`awk '{…}'`: 0, `ssh host '…'`: 1).
 */
type Interpreter = { language: string; flags: readonly string[]; positional?: number }

const python: Interpreter = { language: 'python', flags: ['-c'] }
const js: Interpreter = { language: 'javascript', flags: ['-e', '-p', '--eval', '--print'] }
const ts: Interpreter = { language: 'typescript', flags: ['-e', '-p', '--eval', '--print'] }
const bash: Interpreter = { language: 'bash', flags: ['-c'] }
const powershell: Interpreter = { language: 'powershell', flags: ['-c', '-command'] }
const awk: Interpreter = { language: 'awk', flags: [], positional: 0 }

const INTERPRETERS: Record<string, Interpreter> = {
  python,
  py: python,
  pypy: python,
  ipython: python,
  node: js,
  nodejs: js,
  bun: js,
  deno: { language: 'typescript', flags: ['eval'] },
  'ts-node': ts,
  tsx: ts,
  ruby: { language: 'ruby', flags: ['-e'] },
  perl: { language: 'perl', flags: ['-e'] },
  php: { language: 'php', flags: ['-r'] },
  bash,
  sh: bash,
  zsh: bash,
  dash: bash,
  ksh: bash,
  ssh: { language: 'bash', flags: [], positional: 1 },
  pwsh: powershell,
  powershell,
  cmd: { language: 'dos', flags: ['/c', '/k'] },
  psql: { language: 'sql', flags: ['-c', '--command'] },
  mysql: { language: 'sql', flags: ['-e', '--execute'] },
  sqlite3: { language: 'sql', flags: ['-cmd'], positional: 1 },
  duckdb: { language: 'sql', flags: ['-c'], positional: 1 },
  r: { language: 'r', flags: ['-e'] },
  rscript: { language: 'r', flags: ['-e'] },
  julia: { language: 'julia', flags: ['-e', '--eval'] },
  lua: { language: 'lua', flags: ['-e'] },
  osascript: { language: 'applescript', flags: ['-e'] },
  awk,
  gawk: awk,
  mawk: awk,
}

// Commands that run the next one (`uv run python`, `docker exec box sh`): an
// interpreter is looked for past these, and past nothing else, so `echo
// python` names none.
const WRAPPERS = new Set([
  'uv', 'uvx', 'env', 'sudo', 'doas', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'timeout', 'stdbuf',
  'xargs', 'npx', 'pnpm', 'yarn', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'conda', 'mamba', 'micromamba', 'pixi',
  'docker', 'podman', 'kubectl', 'winpty', 'watch',
])

// Commands that write what they are given to a file, which names its language.
const WRITERS = new Set(['cat', 'tee', 'set-content', 'add-content', 'out-file', 'tee-object'])
const PATH_FLAGS = new Set(['-path', '-filepath', '-literalpath'])

// A command's name as the tables key it: no folder, no `.exe`, no version.
const nameOf = (word: string) =>
  (word.split(/[\\/]/).pop() ?? word)
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/^(python|pypy|ruby|perl|php|lua)[\d.]*$/, '$1')

type Quote = {
  /** The offset before the quoted text: its opening quote, or a here-string's line break. */
  open: number
  /** The offset after it: its closing quote, or the line break before a here-string's close. */
  close: number
  /** A here-string: on rows of its own already, so even one line is drawn apart. */
  isBlock?: boolean
}
type Word = { value: string; quote?: Quote }
type Command = { words: Word[]; target?: string }
type Where = { language?: string; path?: string }
type Region = { start: number; end: number } & Where

// Where a command's words start: past assignments (`X=1`) and PowerShell's
// call operators (`& "C:\py\python.exe"`).
const firstWord = (words: readonly Word[]) => {
  let first = 0
  while (first < words.length && (/^[A-Za-z_]\w*=/.test(words[first]!.value) || words[first]!.value === '&' || words[first]!.value === '.')) first++
  return first
}

function interpreterOf(words: readonly Word[]): { index: number; spec: Interpreter } | undefined {
  const first = firstWord(words)
  for (let k = first; k < words.length; k++) {
    const name = nameOf(words[k]!.value)
    const spec = INTERPRETERS[name]
    if (spec !== undefined) return { index: k, spec }
    if (k === first && !WRAPPERS.has(name)) return undefined
  }
  return undefined
}

// The file a writer writes to: its redirect, its path flag, else its first
// positional argument (one not following a flag).
function writtenPath(command: Command, upTo = command.words.length): string | undefined {
  const { words } = command
  const first = firstWord(words)
  if (!WRITERS.has(nameOf(words[first]?.value ?? ''))) return undefined
  if (command.target !== undefined) return command.target
  for (let k = first + 1; k < upTo; k++) {
    const value = words[k]!.value
    if (PATH_FLAGS.has(value.toLowerCase())) return words[k + 1]?.value
    if (!value.startsWith('-') && !(words[k - 1]!.value.startsWith('-') && k - 1 > first)) {
      if (nameOf(words[first]!.value) === 'cat' && words[k]!.quote === undefined) return undefined
      return value
    }
  }
  return undefined
}

// What text fed to a command is: the code of the program it is fed to, else
// the file it is written to, else plain text (a commit message).
function fedTo(command: Command): Where {
  const found = interpreterOf(command.words)
  if (found !== undefined) return { language: found.spec.language }
  const path = writtenPath(command)
  return path !== undefined ? { path } : {}
}

// A quoted argument a program reads as code (`python -c "…"`), or a writer
// writes to a file (`Set-Content x.py -Value @'…'@`). One line stays in the
// shell's block: drawn apart, it would take three rows.
function codeArgument(src: string, command: Command, word: Word): Region | undefined {
  if (word.quote === undefined) return undefined
  const { open, close, isBlock } = word.quote
  if (!isBlock && !src.slice(open + 1, close).includes('\n')) return undefined
  const span = { start: open + 1, end: close }
  const k = command.words.length - 1
  const found = interpreterOf(command.words)
  if (found !== undefined) {
    if (k <= found.index) return undefined
    const { spec } = found
    const flag = command.words[k - 1]!.value.toLowerCase()
    const positionals = command.words.slice(found.index + 1, k).filter(w => !w.value.startsWith('-')).length
    const isCode = spec.flags.includes(flag) || (spec.positional !== undefined && positionals >= spec.positional)
    return isCode ? { ...span, language: spec.language } : undefined
  }
  const path = writtenPath(command, k)
  return path !== undefined ? { ...span, path } : undefined
}

type WordBuilder = { value: string; start: number; isPure: boolean; quote?: Quote }
type Closer = ')' | '`' | '}' | null
type CommandFrame = { kind: 'command'; closer: Closer; command: Command; word: WordBuilder | null; isRedirect: boolean }
type QuoteFrame = { kind: 'quote'; open: number }

// What both scanners share: a stack of command frames and double-quote
// frames, the words of each frame's command, and the regions found.
function scanner(src: string) {
  const regions: Region[] = []
  const frame = (closer: Closer): CommandFrame => ({ kind: 'command', closer, command: { words: [] }, word: null, isRedirect: false })
  const stack: Array<CommandFrame | QuoteFrame> = [frame(null)]

  // The word a character joins, started at `at` if none is open; joining one
  // already open makes it more than a single quoted string.
  const join = (f: CommandFrame, at: number) => {
    if (f.word === null) f.word = { value: '', start: at, isPure: true }
    else f.word.isPure = false
    return f.word
  }

  const endWord = (f: CommandFrame) => {
    const built = f.word
    if (built === null) return
    f.word = null
    if (f.isRedirect) {
      f.isRedirect = false
      f.command.target ??= built.value
      return
    }
    const word: Word = { value: built.value, ...(built.isPure && built.quote !== undefined && { quote: built.quote }) }
    f.command.words.push(word)
    const region = codeArgument(src, f.command, word)
    if (region !== undefined) regions.push(region)
  }

  const resetCommand = (f: CommandFrame) => {
    f.command = { words: [] }
    f.isRedirect = false
  }

  // A redirect at `i`: `>`, `>>`, `>|`, `2>&1`; a word naming the stream
  // (`2`, `*`) just before it is no argument. Returns where it ends.
  const redirect = (f: CommandFrame, i: number) => {
    if (f.word !== null && f.word.start === i - 1 && /^[\d*&]$/.test(f.word.value)) f.word = null
    endWord(f)
    let j = i + 1
    if (src[j] === '>' || src[j] === '|') j++
    if (src[j] === '&') j += /\d/.test(src[j + 1] ?? '') ? 2 : 1
    else f.isRedirect = true
    return j
  }

  // The words still open where the command ends, innermost first.
  const finish = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k]!
      if (f.kind === 'command') endWord(f)
    }
    return regions
  }

  return { regions, stack, frame, join, endWord, resetCommand, redirect, finish }
}

const BREAKS = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '<', '>', '(', ')'])

// Bash: each heredoc's body read at the end of its line, each multi-line
// quoted argument as it ends.
function bashRegions(src: string): Region[] {
  const { regions, stack, frame, join, endWord, resetCommand, redirect, finish } = scanner(src)
  const pending: Array<{ delimiter: string; isTabStripped: boolean; command: Command }> = []

  const endCommand = (f: CommandFrame) => {
    endWord(f)
    resetCommand(f)
  }

  // `<<` read at `at` (past it): the delimiter, its quotes and backslashes
  // dropped, waits for the end of the line.
  const heredoc = (f: CommandFrame, at: number) => {
    let j = at
    const isTabStripped = src[j] === '-'
    if (isTabStripped) j++
    while (src[j] === ' ' || src[j] === '\t') j++
    let delimiter = ''
    while (j < src.length && !BREAKS.has(src[j]!)) {
      const c = src[j]!
      if (c === "'" || c === '"') {
        const close = src.indexOf(c, j + 1)
        const end = close < 0 ? src.length : close
        delimiter += src.slice(j + 1, end)
        j = end + 1
      } else if (c === '\\') {
        delimiter += src[j + 1] ?? ''
        j += 2
      } else {
        delimiter += c
        j++
      }
    }
    if (delimiter !== '') pending.push({ delimiter, isTabStripped, command: f.command })
    return j
  }

  // The bodies of the line's heredocs, from `at` (past its newline), in the
  // order their `<<`s stood: each up to its delimiter's line, which is skipped.
  const bodies = (at: number) => {
    let pos = at
    for (const h of pending) {
      const start = pos
      let end = src.length
      let next = src.length
      for (let p = pos; p < src.length; ) {
        const nl = src.indexOf('\n', p)
        const lineEnd = nl < 0 ? src.length : nl
        const line = src.slice(p, lineEnd).replace(/\r$/, '')
        if ((h.isTabStripped ? line.replace(/^\t+/, '') : line) === h.delimiter) {
          end = p
          next = Math.min(lineEnd + 1, src.length)
          break
        }
        p = lineEnd + 1
      }
      if (end > start) regions.push({ start, end, ...fedTo(h.command) })
      pos = next
    }
    pending.length = 0
    return pos
  }

  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1]!
    const c = src[i]!

    if (top.kind === 'quote') {
      const word = (stack[stack.length - 2] as CommandFrame).word!
      if (c === '\\') {
        word.value += src.slice(i, i + 2)
        i += 2
      } else if (c === '"') {
        stack.pop()
        if (word.start === top.open) word.quote = { open: top.open, close: i }
        i++
      } else if (c === '$' && src[i + 1] === '(') {
        word.isPure = false
        stack.push(frame(')'))
        i += 2
      } else if (c === '`') {
        word.isPure = false
        stack.push(frame('`'))
        i++
      } else {
        word.value += c
        i++
      }
      continue
    }

    const f = top
    if (c === '\n') {
      endCommand(f)
      i = pending.length > 0 ? bodies(i + 1) : i + 1
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord(f)
      i++
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') join(f, i).value += src[i + 1] ?? ''
      i += 2
    } else if (c === '#' && f.word === null) {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
    } else if (c === "'") {
      const word = join(f, i)
      const close = src.indexOf("'", i + 1)
      const end = close < 0 ? src.length : close
      word.value += src.slice(i + 1, end)
      if (word.start === i) word.quote = { open: i, close: end }
      i = end + 1
    } else if (c === '"') {
      join(f, i)
      stack.push({ kind: 'quote', open: i })
      i++
    } else if (c === '$' && src[i + 1] === '(') {
      join(f, i).isPure = false
      stack.push(frame(')'))
      i += 2
    } else if (c === '`') {
      if (f.closer === '`') {
        endCommand(f)
        stack.pop()
      } else {
        join(f, i).isPure = false
        stack.push(frame('`'))
      }
      i++
    } else if (c === '(') {
      endWord(f)
      stack.push(frame(')'))
      i++
    } else if (c === ')') {
      endCommand(f)
      if (f.closer === ')') stack.pop()
      i++
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord(f)
      i = heredoc(f, i + 2)
    } else if (c === '<') {
      endWord(f)
      i += src.startsWith('<<<', i) ? 3 : 1
    } else if (c === '>') {
      i = redirect(f, i)
    } else if (c === ';' || c === '&' || c === '|') {
      endCommand(f)
      i++
    } else {
      join(f, i).value += c
      i++
    }
  }
  return finish()
}

// PowerShell: backtick escapes, doubled quotes, here-strings (`@'…'@`) as
// arguments or piped into the next command, `&` as the call operator, script
// blocks in braces.
function powershellRegions(src: string): Region[] {
  const { regions, stack, frame, join, endWord, resetCommand, redirect, finish } = scanner(src)
  // A command that was one multi-line string, piped on to the next.
  let piped: Word | undefined

  const endCommand = (f: CommandFrame, isPipe = false) => {
    endWord(f)
    const { words } = f.command
    if (piped?.quote !== undefined && words.length > 0) {
      const where = fedTo(f.command)
      if (where.language !== undefined || where.path !== undefined) regions.push({ start: piped.quote.open + 1, end: piped.quote.close, ...where })
      piped = undefined
    }
    const only = words.length === 1 ? words[0] : undefined
    if (isPipe && only?.quote !== undefined && (only.quote.isBlock || src.slice(only.quote.open + 1, only.quote.close).includes('\n'))) piped = only
    else if (words.length > 0) piped = undefined
    resetCommand(f)
  }

  // Whether `@'` or `@"` at `i` opens a here-string: nothing after it on its line.
  const isHereString = (i: number) => {
    const nl = src.indexOf('\n', i + 2)
    return nl >= 0 && src.slice(i + 2, nl).trim() === ''
  }

  // The here-string opened at `i`, as a word, up to the line its close (`'@`,
  // `"@`) starts. Returns where it ends.
  const hereString = (f: CommandFrame, i: number) => {
    const q = src[i + 1]!
    const nl = src.indexOf('\n', i + 2)
    let closeLine = src.length
    for (let p = nl + 1; p < src.length; ) {
      if (src.startsWith(`${q}@`, p)) {
        closeLine = p
        break
      }
      const next = src.indexOf('\n', p)
      if (next < 0) break
      p = next + 1
    }
    const word = join(f, i)
    const close = closeLine === src.length ? src.length : Math.max(nl, closeLine - 1)
    word.value += src.slice(nl + 1, close)
    if (word.start === i) word.quote = { open: nl, close, isBlock: true }
    return closeLine === src.length ? src.length : closeLine + 2
  }

  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1]!
    const c = src[i]!

    if (top.kind === 'quote') {
      const word = (stack[stack.length - 2] as CommandFrame).word!
      if (c === '`' || (c === '"' && src[i + 1] === '"')) {
        word.value += src.slice(i, i + 2)
        i += 2
      } else if (c === '"') {
        stack.pop()
        if (word.start === top.open) word.quote = { open: top.open, close: i }
        i++
      } else if (c === '$' && src[i + 1] === '(') {
        word.isPure = false
        stack.push(frame(')'))
        i += 2
      } else {
        word.value += c
        i++
      }
      continue
    }

    const f = top
    const pair = src.slice(i, i + 2)
    if (c === '\n') {
      endCommand(f)
      i++
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord(f)
      i++
    } else if (c === '`') {
      if (src[i + 1] === '\n' || pair === '`\r') i += src[i + 1] === '\r' ? 3 : 2
      else {
        join(f, i).value += src[i + 1] ?? ''
        i += 2
      }
    } else if (pair === '<#') {
      const end = src.indexOf('#>', i + 2)
      i = end < 0 ? src.length : end + 2
    } else if (c === '#' && f.word === null) {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
    } else if ((pair === "@'" || pair === '@"') && isHereString(i)) {
      i = hereString(f, i)
    } else if (c === "'") {
      const word = join(f, i)
      let end = src.length
      for (let j = i + 1; j < src.length; ) {
        const at = src.indexOf("'", j)
        if (at < 0) break
        if (src[at + 1] === "'") j = at + 2
        else {
          end = at
          break
        }
      }
      word.value += src.slice(i + 1, end)
      if (word.start === i) word.quote = { open: i, close: end }
      i = end + 1
    } else if (c === '"') {
      join(f, i)
      stack.push({ kind: 'quote', open: i })
      i++
    } else if (pair === '$(' || pair === '@(' || c === '(') {
      join(f, i).isPure = false
      stack.push(frame(')'))
      i += c === '(' ? 1 : 2
    } else if (pair === '@{' || c === '{') {
      endWord(f)
      stack.push(frame('}'))
      i += c === '{' ? 1 : 2
    } else if (c === ')' || c === '}') {
      endCommand(f)
      if (f.closer === c) stack.pop()
      i++
    } else if (pair === '&&' || pair === '||') {
      endCommand(f)
      i += 2
    } else if (c === '&' && f.word === null) {
      f.command.words.push({ value: '&' })
      i++
    } else if (c === '|') {
      endCommand(f, true)
      i++
    } else if (c === ';') {
      endCommand(f)
      i++
    } else if (c === '>') {
      i = redirect(f, i)
    } else {
      join(f, i).value += c
      i++
    }
  }
  // The commands still open end with the input, so a pipe's last reader counts.
  for (let k = stack.length - 1; k >= 0; k--) {
    const open = stack[k]!
    if (open.kind === 'command') endCommand(open)
  }
  return finish()
}

const SCANNERS: Record<Shell, (src: string) => Region[]> = { bash: bashRegions, powershell: powershellRegions }
const isShell = (language: string | undefined): language is Shell => language === 'bash' || language === 'powershell'

// Exact slices: joined, they are `src` again.
function slices(src: string, shell: Shell, depth: number): Segment[] {
  const out: Segment[] = []
  let at = 0
  const regions = depth >= MAX_DEPTH ? [] : SCANNERS[shell](src).sort((a, b) => a.start - b.start)
  for (const region of regions) {
    if (region.start < at) continue
    out.push({ text: src.slice(at, region.start), language: shell })
    const text = src.slice(region.start, region.end)
    if (isShell(region.language)) out.push(...slices(text, region.language, depth + 1))
    else {
      const where: Where =
        region.language !== undefined ? { language: region.language } : region.path !== undefined ? { path: region.path } : {}
      out.push({ text, ...where })
    }
    at = region.end
  }
  out.push({ text: src.slice(at), language: shell })
  return out
}

/**
 * The blocks a command draws as, in order: neighbours in one language
 * merged, each block's own line breaks at its edges dropped (a block starts
 * on a row of its own), blank ones left out.
 */
export function splitCommand(command: string, shell: Shell = 'bash'): Segment[] {
  const merged: Segment[] = []
  for (const piece of slices(command, shell, 0)) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.language === piece.language && last.path === piece.path) last.text += piece.text
    else merged.push({ ...piece })
  }
  return merged
    .map(s => ({ ...s, text: s.text.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '') }))
    .filter(s => s.text.trim() !== '')
}

/** Blocks cut to `max` lines in all, and how many lines were left out. */
export function cutSegments(segments: readonly Segment[], max: number): { segments: Segment[]; hidden: number } {
  const total = segments.reduce((n, s) => n + s.text.split('\n').length, 0)
  if (total <= max) return { segments: [...segments], hidden: 0 }
  // One line goes to saying how many are left out, as `compact` does.
  let room = max - 1
  const kept: Segment[] = []
  for (const s of segments) {
    if (room <= 0) break
    const lines = s.text.split('\n')
    kept.push(lines.length <= room ? s : { ...s, text: lines.slice(0, room).join('\n') })
    room -= lines.length
  }
  return { segments: kept, hidden: total - (max - 1) }
}

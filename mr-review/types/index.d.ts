export type Severity = 'high' | 'medium' | 'low'

export type Category =
  | 'security'
  | 'performance'
  | 'correctness'
  | 'merge'
  | 'tests'
  | 'maintainability'

export type Finding = {
  id: string
  severity: Severity
  category: Category
  file: string
  line: number | null
  title: string
  detail: string
  suggestion: string | null
  isDismissed: boolean
}

export type Commit = { hash: string; author: string; age: string; subject: string }

export type FileChange = {
  path: string
  status: string
  added: number
  removed: number
  isBinary: boolean
}

export type CheckLevel = 'ok' | 'warn' | 'fail'

export type Check = { id: string; level: CheckLevel; title: string; detail: string | null }

export type MrInfo = {
  source: 'gitlab' | 'github'
  number: string
  title: string
  url: string
  author: string | null
  state: string | null
  target: string | null
  checks: string | null
  description: string | null
}

export type ReviewStatus = 'collecting' | 'reviewing' | 'done' | 'error'

export type Verdict = { kind: 'ready' | 'needs-work' | 'blocked'; summary: string }

export type Review = {
  status: ReviewStatus
  args: string
  startedAt: number
  cwd: string
  root: string
  branch: string
  target: string
  targetRef: string
  isTargetFetched: boolean
  base: string
  behind: number
  commits: Commit[]
  files: FileChange[]
  insertions: number
  deletions: number
  diffChars: number
  isDiffTruncated: boolean
  conflicts: string[]
  checks: Check[]
  mr: MrInfo | null
  verdict: Verdict | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'mr-review': {
      review: Review | null
      findings: Finding[]
      selected: string | null
    }
  }
}

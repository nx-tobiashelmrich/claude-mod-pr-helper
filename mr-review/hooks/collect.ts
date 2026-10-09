import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { Commit, FileChange, MrInfo } from '../types'

export type Run = { ok: boolean; code: number; out: string; err: string }
/** Runs a host command: `$.process.run` as the hooks module hands it over. */
export type Runner = (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
export type Git = (args: readonly string[], timeoutMs?: number) => Promise<Run>

/** The most of the diff handed to the model, in characters. */
export const DIFF_LIMIT = 300_000
/** The most of one file's diff handed to the model; the rest it reads with git when it matters. */
export const FILE_DIFF_LIMIT = 30_000
export const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|mix\.lock)$/
const GENERATED = /\.(min\.js|min\.css|map|snap)$|(^|\/)(dist|build|out|coverage|__snapshots__)\//

export type Facts = {
  root: string
  branch: string
  target: string
  targetRef: string
  isTargetFetched: boolean
  base: string
  behind: number
  mergeCommits: number
  commits: Commit[]
  files: FileChange[]
  insertions: number
  deletions: number
  conflicts: string[]
  mergeNote: string | null
  diff: string
  diffChars: number
  isDiffTruncated: boolean
  /** Files whose hunks were dropped or cut from the diff handed to the model, one note each. */
  diffNotes: string[]
}

export type CollectOptions = { target: string; remote: string; fetch: boolean }

export function gitRunner(run: Runner, cwd: string): Git {
  return async (args, timeoutMs = 30_000) => {
    try {
      const ran = await run(['git', ...args], { cwd, timeoutMs })
      return {
        ok: ran.exitCode === 0,
        code: ran.exitCode,
        out: ran.stdout.replace(/\s+$/, ''),
        err: ran.stderr.trim(),
      }
    } catch (error) {
      return { ok: false, code: -1, out: '', err: error instanceof Error ? error.message : String(error) }
    }
  }
}

export async function collectFacts(git: Git, options: CollectOptions): Promise<Facts | { error: string }> {
  const top = await git(['rev-parse', '--show-toplevel'])
  if (!top.ok) return { error: `not a git repository (${top.err || 'git rev-parse failed'})` }
  const root = top.out

  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return { error: `cannot read HEAD (${head.err})` }
  let branch = head.out
  if (branch === 'HEAD') {
    const short = await git(['rev-parse', '--short', 'HEAD'])
    branch = `detached@${short.out}`
  }
  if (branch === options.target) {
    return { error: `HEAD is on ${options.target} itself; check out the merge request branch first` }
  }

  let isTargetFetched = false
  if (options.fetch) {
    const fetched = await git(['fetch', '--quiet', options.remote, options.target], 20_000)
    isTargetFetched = fetched.ok
  }
  const candidates = [`${options.remote}/${options.target}`, options.target]
  let targetRef: string | null = null
  for (const ref of candidates) {
    const verified = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (verified.ok) {
      targetRef = ref
      break
    }
  }
  if (targetRef === null) {
    return { error: `target branch "${options.target}" not found (tried ${candidates.join(', ')})` }
  }

  const base = await git(['merge-base', targetRef, 'HEAD'])
  if (!base.ok) return { error: `no merge base between ${targetRef} and HEAD (${base.err})` }
  const headSha = await git(['rev-parse', 'HEAD'])
  const targetSha = await git(['rev-parse', `${targetRef}^{commit}`])
  if (headSha.out === targetSha.out) return { error: `HEAD is the same commit as ${targetRef}; nothing to review` }

  const behind = await git(['rev-list', '--count', `HEAD..${targetRef}`])
  const merges = await git(['rev-list', '--count', '--merges', `${base.out}..HEAD`])
  const log = await git(['log', '--format=%h%x09%an%x09%ar%x09%s', `${base.out}..HEAD`])
  const numstat = await git(['diff', '--numstat', '--no-renames', base.out, 'HEAD'])
  const status = await git(['diff', '--name-status', '--no-renames', base.out, 'HEAD'])
  const merge = await git(['merge-tree', '--write-tree', '--name-only', targetRef, 'HEAD'], 60_000)
  const diffRun = await git(['diff', '--no-color', '--no-ext-diff', '--no-renames', base.out, 'HEAD'], 60_000)

  const files = parseFiles(numstat.out, status.out)
  const { conflicts, mergeNote } = parseMergeTree(merge)
  const pruned = pruneDiff(diffRun.out)
  const isDiffTruncated = pruned.diff.length > DIFF_LIMIT

  return {
    root,
    branch,
    target: options.target,
    targetRef,
    isTargetFetched,
    base: base.out,
    behind: Number(behind.out) || 0,
    mergeCommits: Number(merges.out) || 0,
    commits: parseCommits(log.out),
    files,
    insertions: files.reduce((sum, file) => sum + file.added, 0),
    deletions: files.reduce((sum, file) => sum + file.removed, 0),
    conflicts,
    mergeNote,
    diff: isDiffTruncated ? pruned.diff.slice(0, DIFF_LIMIT) : pruned.diff,
    diffChars: pruned.diff.length,
    isDiffTruncated,
    diffNotes: pruned.notes,
  }
}

/**
 * Drops lockfile and generated-file hunks from the diff and cuts any one file
 * to FILE_DIFF_LIMIT characters, so the model's context holds the code that
 * needs reading. The pre-checks still see the full diff through `files`.
 */
export function pruneDiff(diff: string): { diff: string; notes: string[] } {
  if (diff === '') return { diff, notes: [] }
  const sections = diff.split(/^(?=diff --git )/m)
  const notes: string[] = []
  const kept: string[] = []
  for (const section of sections) {
    const header = /^diff --git a\/(.*?) b\/(.*)$/m.exec(section)
    const path = header?.[2] ?? header?.[1] ?? ''
    if (path !== '' && (LOCKFILE.test(path) || GENERATED.test(path))) {
      notes.push(`${path}: ${LOCKFILE.test(path) ? 'lockfile' : 'generated file'}, hunks left out`)
      kept.push(`${section.split('\n')[0] ?? ''}\n(hunks left out: ${LOCKFILE.test(path) ? 'lockfile' : 'generated file'})\n`)
      continue
    }
    if (section.length > FILE_DIFF_LIMIT) {
      notes.push(`${path}: ${section.length} characters, cut after ${FILE_DIFF_LIMIT}`)
      kept.push(`${section.slice(0, FILE_DIFF_LIMIT)}\n(cut: ${section.length - FILE_DIFF_LIMIT} more characters of ${path}; run git diff for the rest)\n`)
      continue
    }
    kept.push(section)
  }

  return { diff: kept.join(''), notes }
}

export function parseCommits(text: string): Commit[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [hash = '', author = '', age = '', ...rest] = line.split('\t')
      return { hash, author, age, subject: rest.join('\t') }
    })
}

export function parseFiles(numstat: string, nameStatus: string): FileChange[] {
  const statusByPath = new Map<string, string>()
  for (const line of nameStatus.split('\n')) {
    const [status = '', ...path] = line.split('\t')
    if (status !== '' && path.length > 0) statusByPath.set(path.join('\t'), status.charAt(0))
  }

  return numstat
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [added = '', removed = '', ...rest] = line.split('\t')
      const path = rest.join('\t')
      const isBinary = added === '-' || removed === '-'

      return {
        path,
        status: statusByPath.get(path) ?? 'M',
        added: isBinary ? 0 : Number(added) || 0,
        removed: isBinary ? 0 : Number(removed) || 0,
        isBinary,
      }
    })
}

/**
 * `git merge-tree --write-tree --name-only` prints the tree id, then on a
 * conflict the conflicted paths up to a blank line, then its messages.
 */
export function parseMergeTree(run: Run): { conflicts: string[]; mergeNote: string | null } {
  if (run.ok) return { conflicts: [], mergeNote: null }
  if (run.code === 1) {
    const conflicts: string[] = []
    for (const line of run.out.split('\n').slice(1)) {
      if (line.trim() === '') break
      conflicts.push(line.trim())
    }

    return { conflicts, mergeNote: null }
  }

  return { conflicts: [], mergeNote: `merge check unavailable: ${run.err || `git merge-tree exited ${run.code}`}` }
}

export async function collectMr(run: Runner, cwd: string): Promise<MrInfo | null> {
  const gitlab = asRecord(await runJson(run, ['glab', 'mr', 'view', '--output', 'json'], cwd))
  if (gitlab !== null && str(gitlab, 'title') !== null) {
    const author = asRecord(gitlab.author)
    const pipeline = asRecord(gitlab.head_pipeline) ?? asRecord(gitlab.pipeline)

    return {
      source: 'gitlab',
      number: `!${num(gitlab, 'iid') ?? '?'}`,
      title: str(gitlab, 'title') ?? '',
      url: str(gitlab, 'web_url') ?? '',
      author: author === null ? null : (str(author, 'name') ?? str(author, 'username')),
      state: str(gitlab, 'state') ?? str(gitlab, 'detailed_merge_status'),
      target: str(gitlab, 'target_branch'),
      checks: pipeline === null ? null : `pipeline ${str(pipeline, 'status') ?? 'unknown'}`,
      description: str(gitlab, 'description'),
    }
  }

  const github = asRecord(
    await runJson(
      run,
      ['gh', 'pr', 'view', '--json', 'number,title,url,author,state,baseRefName,body,reviewDecision,mergeable,statusCheckRollup'],
      cwd,
    ),
  )
  if (github !== null && str(github, 'title') !== null) {
    const author = asRecord(github.author)
    const decision = str(github, 'reviewDecision')
    const state = [str(github, 'state'), decision === '' ? null : decision, str(github, 'mergeable')]
      .filter((part): part is string => part !== null)
      .join(', ')
      .toLowerCase()

    return {
      source: 'github',
      number: `#${num(github, 'number') ?? '?'}`,
      title: str(github, 'title') ?? '',
      url: str(github, 'url') ?? '',
      author: author === null ? null : str(author, 'login'),
      state: state === '' ? null : state,
      target: str(github, 'baseRefName'),
      checks: githubChecks(github.statusCheckRollup),
      description: str(github, 'body'),
    }
  }

  return null
}

function githubChecks(rollup: unknown): string | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null
  let passed = 0
  let failed = 0
  let pending = 0
  for (const item of rollup) {
    const check = asRecord(item)
    const conclusion = check === null ? '' : (str(check, 'conclusion') ?? str(check, 'state') ?? '')
    const status = check === null ? '' : (str(check, 'status') ?? '')
    if (/FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/i.test(conclusion)) failed += 1
    else if (/SUCCESS|NEUTRAL|SKIPPED/i.test(conclusion)) passed += 1
    else if (status !== '' && !/COMPLETED/i.test(status)) pending += 1
    else pending += 1
  }

  return `checks: ${passed} passed, ${failed} failed, ${pending} pending`
}

async function runJson(run: Runner, argv: readonly string[], cwd: string): Promise<unknown> {
  try {
    const ran = await run(argv, { cwd, timeoutMs: 15_000 })
    if (ran.exitCode !== 0 || ran.stdout.trim() === '') return null

    return JSON.parse(ran.stdout) as unknown
  } catch {
    return null
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]

  return typeof value === 'string' ? value : null
}

export function num(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

import type { On, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { addedLines, runChecks } from '../hooks/checks'
import { parseMergeTree } from '../hooks/collect'
import type { Facts } from '../hooks/collect'
import { parseArgs, parseFinding } from '../hooks/register'
import type { Finding, Review } from '../types'

const REPO = '/repo'
const BASE = '32bb977'
// Assembled at runtime so no key-shaped literal sits in the repository (GitHub push protection rejects one).
const FAKE_STRIPE_KEY = ['sk', 'live', 'FAKE0000FAKE0000FAKE0000'].join('_')

const DIFF = [
  'diff --git a/src/db.ts b/src/db.ts',
  'index 1111111..2222222 100644',
  '--- a/src/db.ts',
  '+++ b/src/db.ts',
  '@@ -8,3 +8,3 @@ export async function query() {',
  ' }',
  ' ',
  '-export const DEFAULT_PAGE_SIZE = 50',
  '+export const DEFAULT_PAGE_SIZE = 500 // exports need bigger pages',
  'diff --git a/src/export.ts b/src/export.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/export.ts',
  '@@ -0,0 +1,6 @@',
  "+import { query } from './db'",
  `+const EXPORT_API_KEY = "${FAKE_STRIPE_KEY}"`,
  '+export async function exportUsers(nameFilter: string) {',
  "+  console.log('exporting', nameFilter)",
  "+  return query(`SELECT id FROM users WHERE name LIKE '%${nameFilter}%'`)",
  '+}',
  '',
].join('\n')

const ok = (stdout: string): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})
const fail = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** A feature branch three commits ahead of develop, two behind, conflicting in src/db.ts. */
function sampleRepo(argv: readonly string[]): ProcessRunResult {
  const line = argv.join(' ')
  if (argv[0] === 'glab' || argv[0] === 'gh') return fail(127, '', `${argv[0]}: command not found`)
  if (line === 'git rev-parse --show-toplevel') return ok(REPO)
  if (line === 'git rev-parse --abbrev-ref HEAD') return ok('feature/user-export')
  if (line.startsWith('git fetch ')) return fail(128, '', 'fatal: no remote')
  if (line === 'git rev-parse --verify --quiet origin/develop^{commit}') return fail(1)
  if (line === 'git rev-parse --verify --quiet develop^{commit}') return ok('0ddc92d')
  if (line === 'git merge-base develop HEAD') return ok(BASE)
  if (line === 'git rev-parse HEAD') return ok('bf8f84e')
  if (line === 'git rev-parse develop^{commit}') return ok('0ddc92d')
  if (line === 'git rev-list --count HEAD..develop') return ok('2')
  if (line === `git rev-list --count --merges ${BASE}..HEAD`) return ok('0')
  if (line.startsWith('git log ')) {
    return ok(
      [
        'bf8f84e\tDemo\t1 hour ago\tfixup! Add user export endpoint',
        'dacbc25\tDemo\t1 hour ago\tAdd user export endpoint',
        '33c090f\tDemo\t2 hours ago\twip',
      ].join('\n'),
    )
  }
  if (line.startsWith('git diff --numstat')) return ok('1\t1\tsrc/db.ts\n6\t0\tsrc/export.ts')
  if (line.startsWith('git diff --name-status')) return ok('M\tsrc/db.ts\nA\tsrc/export.ts')
  if (line.startsWith('git merge-tree')) {
    return fail(1, '07dbbe0\nsrc/db.ts\n\nAuto-merging src/db.ts\nCONFLICT (content): Merge conflict in src/db.ts')
  }
  if (line.startsWith('git diff --no-color')) return ok(DIFF)
  throw new Error(`unexpected command: ${line}`)
}

function notARepo(argv: readonly string[]): ProcessRunResult {
  if (argv[0] === 'glab' || argv[0] === 'gh') return fail(127, '', `${argv[0]}: command not found`)

  return fail(128, '', 'fatal: not a git repository (or any of the parent directories): .git')
}

type Submitted = { text: string; context: readonly string[]; origin: unknown }
type Seen = { review: Review | null; findings: Finding[]; status: string | undefined; logs: string[] }

/** The world beneath the plugin: a clock, a fake repo, every `$` call the mod makes answered, and its state writes watched. */
function world(on: On, answer: (argv: readonly string[]) => ProcessRunResult, submitted: Submitted[]) {
  const seen: Seen = { review: null, findings: [], status: undefined, logs: [] }
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const session = mock.session(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => ({ value: answer(e.argv) }))
  on('session.cwd', () => ({ value: REPO }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__mr-review__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, context: e.context ?? [], origin: e.origin })

    return { text: e.text, context: e.context }
  })
  on('state.set', { plugin: 'mr-review', key: 'review' }, ($, e, next) => {
    seen.review = e.value as Review | null

    return next(e)
  })
  on('state.set', { plugin: 'mr-review', key: 'findings' }, ($, e, next) => {
    seen.findings = e.value as Finding[]

    return next(e)
  })

  return { clock, seen, session }
}

const PRESENTATION = { isFullscreen: true, columns: 120 } as const
const PANE_PROPS = {
  title: 'MR review',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const SQL_FINDING = {
  tool: 'mcp__mr-review__finding',
  file: 'src/export.ts',
  line: 5,
  severity: 'high',
  category: 'security',
  title: 'SQL injection through nameFilter',
  detail: 'The LIKE pattern is interpolated into the SQL string; a name containing a quote escapes it.',
  suggestion: 'Pass the pattern as a bound parameter.',
} as const

test('/mr-review collects the facts, runs the pre-checks and briefs the model', async ($, on) => {
  const submitted: Submitted[] = []
  const { clock, seen, session } = world(on, sampleRepo, submitted)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  const out = await $.command.run({ command: 'mr-review', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
  await clock.settle()

  expect(out.text).toContain('feature/user-export → develop (develop, local)')
  expect(out.text).toContain('merge conflicts in 1 file')
  expect(out.text).toContain('secret-looking value')

  const review = seen.review
  expect(review?.status).toBe('reviewing')
  expect(review?.branch).toBe('feature/user-export')
  expect(review?.targetRef).toBe('develop')
  expect(review?.base).toBe(BASE)
  expect(review?.behind).toBe(2)
  expect(review?.conflicts).toEqual(['src/db.ts'])
  expect(review?.commits.map(commit => commit.hash)).toEqual(['bf8f84e', 'dacbc25', '33c090f'])
  expect(review?.files.map(file => `${file.status} ${file.path}`)).toEqual(['M src/db.ts', 'A src/export.ts'])
  expect(review?.insertions).toBe(7)
  expect(review?.mr).toBeNull()

  const levels = new Map(review?.checks.map(check => [check.id, check.level]))
  expect(levels.get('conflicts')).toBe('fail')
  expect(levels.get('secrets')).toBe('fail')
  expect(levels.get('behind')).toBe('warn')
  expect(levels.get('sql')).toBe('warn')
  expect(levels.get('debug')).toBe('warn')
  expect(levels.get('commits')).toBe('warn')
  expect(levels.get('tests')).toBe('warn')

  expect(seen.logs).toEqual([])
  expect(submitted).toHaveLength(1)
  expect(submitted[0]?.text).toContain('feature/user-export')
  expect(JSON.stringify(submitted[0]?.origin)).toBe('{"kind":"plugin","name":"mr-review"}')
  expect(submitted[0]?.text.length).toBeLessThan(400)

  const rows = session.appended().filter(row => row.door === 'note')
  expect(rows).toHaveLength(2)
  const texts = rows.map(row => row.message.content.map(block => ('text' in block ? block.text : '')).join(''))
  expect(texts[0]).toContain('mcp__mr-review__finding')
  expect(texts[0]).toContain('CONFLICTS in src/db.ts')
  expect(texts[1]).toContain(FAKE_STRIPE_KEY)
  expect(rows.every(row => row.message.type === 'user')).toBe(true)
  expect(seen.status).toContain('reviewing feature/user-export → develop')
})

test('the finding and done tools fill the pane state and refuse bad input', async ($, on) => {
  const submitted: Submitted[] = []
  const { clock, seen } = world(on, sampleRepo, submitted)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'mr-review', args: '--no-fetch', origin: { kind: 'composer' }, presentation: PRESENTATION })
  await clock.settle()

  const recorded = await $.tool.call(SQL_FINDING)
  expect(String(recorded.result)).toContain('Recorded F1 (high, security) at src/export.ts:5')

  const refused = await $.tool.call({
    tool: 'mcp__mr-review__finding',
    file: 'src/export.ts',
    severity: 'urgent',
    category: 'security',
    title: 'x',
    detail: 'y',
  })
  expect(refused.deny).toContain('severity must be one of')

  const second = await $.tool.call({
    tool: 'mcp__mr-review__finding',
    file: 'src/export.ts',
    severity: 'medium',
    category: 'performance',
    title: 'One query per user in the export loop',
    detail: 'findUser runs once per row.',
  })
  expect(String(second.result)).toContain('Recorded F2')
  expect(seen.status).toContain('1 high · 1 medium')

  const closed = await $.tool.call({ tool: 'mcp__mr-review__done', verdict: 'needs-work', summary: 'Fix the SQL and the N+1 first.' })
  expect(String(closed.result)).toContain('Verdict recorded: needs-work')

  expect(seen.findings.map(finding => `${finding.id}:${finding.severity}:${finding.line ?? '-'}`)).toEqual(['F1:high:5', 'F2:medium:-'])
  expect(seen.review?.status).toBe('done')
  expect(seen.review?.verdict).toEqual({ kind: 'needs-work', summary: 'Fix the SQL and the N+1 first.' })
  expect(seen.status).toContain('needs-work')

  const report = await $.command.run({ command: 'mr-review', args: 'report', origin: { kind: 'composer' }, presentation: PRESENTATION })
  expect(report.text).toContain('## Findings (2: 1 high, 1 medium, 0 low)')
  expect(report.text).toContain('## Verdict: needs-work')
})

test('the pane draws the review on every surface and dismisses a finding', async ($, on) => {
  const submitted: Submitted[] = []
  const { clock, seen } = world(on, sampleRepo, submitted)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'mr-review', args: '--no-fetch', origin: { kind: 'composer' }, presentation: PRESENTATION })
  await clock.settle()
  await $.tool.call(SQL_FINDING)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mr-review', surface, component: 'Pane', requestId: 'mr-review', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'feature/user-export' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /merge conflicts in 1 file/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /src\/export\.ts:5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /secret-looking value/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /SQL injection through nameFilter/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /interpolated into the SQL string/ })).toBeUndefined()

    await ui.press({ key: 'sel:F1' })
    expect(await ui.find({ type: 'Text', text: /interpolated into the SQL string/ })).toBeDefined()
    expect(await ui.find({ key: 'dismiss:F1' })).toBeDefined()

    await ui.press({ key: 'sel:F1' })
    expect(await ui.find({ type: 'Text', text: /interpolated into the SQL string/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'mr-review', surface: 'terminal', component: 'Pane', requestId: 'mr-review', props: PANE_PROPS })
  await ui.press({ key: 'sel:F1' })
  await ui.press({ key: 'explain:F1' })
  expect(seen.logs).toEqual([])
  expect(submitted.map(one => one.text.slice(0, 30))).toEqual(['Review merge request branch `f', 'Explain MR review finding F1 i'])
  expect(submitted).toHaveLength(2)
  expect(submitted[1]?.text).toContain('Explain MR review finding F1')

  await ui.press({ key: 'dismiss:F1' })
  expect(await ui.find({ type: 'Button', text: /SQL injection through nameFilter/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /0 high · 0 medium · 0 low/ })).toBeDefined()
  await ui.unmount()

  expect(seen.findings[0]?.isDismissed).toBe(true)
})

test('the re-run button starts a fresh review without going through the command', async ($, on) => {
  const submitted: Submitted[] = []
  const { clock, seen, session } = world(on, sampleRepo, submitted)
  // `$.command.run` skips the calling plugin's own hooks, so a re-run routed
  // through it would end as "no command.run hook answered it".
  on('command.run', { command: 'mr-review' }, ($, e, next) =>
    e.origin.kind === 'plugin' ? Promise.reject(new Error('re-run went through command.run')) : next(e),
  )
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'mr-review', args: '--no-fetch', origin: { kind: 'composer' }, presentation: PRESENTATION })
  await clock.settle()
  await $.tool.call(SQL_FINDING)
  await $.tool.call({ tool: 'mcp__mr-review__done', verdict: 'needs-work', summary: 'Fix the SQL first.' })
  expect(seen.review?.status).toBe('done')

  const ui = await $.ui.mount({ plugin: 'mr-review', surface: 'terminal', component: 'Pane', requestId: 'mr-review', props: PANE_PROPS })
  await ui.press({ key: 'rerun' })
  await clock.settle()
  await ui.unmount()

  expect(seen.logs).toEqual([])
  expect(seen.review?.status).toBe('reviewing')
  expect(seen.review?.args).toBe('--no-fetch')
  expect(seen.review?.verdict).toBeNull()
  expect(seen.findings).toEqual([])
  expect(submitted).toHaveLength(2)
  expect(submitted[1]?.text).toContain('Review merge request branch `feature/user-export`')
  expect(session.appended().filter(row => row.door === 'note')).toHaveLength(4)
  expect(seen.status).toContain('reviewing feature/user-export → develop · no findings yet')
})

test('outside a git repository the command explains itself and briefs nobody', async ($, on) => {
  const submitted: Submitted[] = []
  const { clock, seen } = world(on, notARepo, submitted)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })

  const out = await $.command.run({ command: 'mr-review', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
  await clock.settle()

  expect(out.text).toContain('not a git repository')
  expect(submitted).toHaveLength(0)
  expect(seen.review?.status).toBe('error')

  const ui = await $.ui.mount({ plugin: 'mr-review', surface: 'terminal', component: 'Pane', requestId: 'mr-review', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()
  await ui.unmount()
})

test('arguments, merge-tree output, diff lines and tool input parse as documented', async () => {
  expect(parseArgs('')).toEqual({ sub: 'review', target: null, repo: null, fetch: null })
  expect(parseArgs('main --no-fetch --repo /x/y')).toEqual({ sub: 'review', target: 'main', repo: '/x/y', fetch: false })
  expect(parseArgs('--repo=/x --target=release')).toEqual({ sub: 'review', target: 'release', repo: '/x', fetch: null })
  expect(parseArgs('report').sub).toBe('report')

  expect(parseMergeTree({ ok: true, code: 0, out: 'abc', err: '' })).toEqual({ conflicts: [], mergeNote: null })
  expect(parseMergeTree({ ok: false, code: 1, out: 'abc\nsrc/a.ts\nsrc/b.ts\n\nCONFLICT (content)', err: '' })).toEqual({
    conflicts: ['src/a.ts', 'src/b.ts'],
    mergeNote: null,
  })
  expect(parseMergeTree({ ok: false, code: 129, out: '', err: 'unknown option' }).mergeNote).toContain('unknown option')

  const lines = addedLines(DIFF)
  expect(lines.map(line => `${line.file}:${line.line}`)).toEqual([
    'src/db.ts:10',
    'src/export.ts:1',
    'src/export.ts:2',
    'src/export.ts:3',
    'src/export.ts:4',
    'src/export.ts:5',
    'src/export.ts:6',
  ])

  const facts: Facts = {
    root: REPO,
    branch: 'feature/x',
    target: 'develop',
    targetRef: 'origin/develop',
    isTargetFetched: true,
    base: BASE,
    behind: 0,
    mergeCommits: 1,
    commits: [{ hash: 'a', author: 'me', age: 'now', subject: 'Add thing' }],
    files: [
      { path: 'package-lock.json', status: 'M', added: 10, removed: 2, isBinary: false },
      { path: 'db/migrate/001_users.sql', status: 'A', added: 3, removed: 0, isBinary: false },
      { path: 'assets/logo.png', status: 'A', added: 0, removed: 0, isBinary: true },
      { path: 'src/a.ts', status: 'M', added: 1, removed: 0, isBinary: false },
      { path: 'src/a.test.ts', status: 'M', added: 1, removed: 0, isBinary: false },
    ],
    insertions: 15,
    deletions: 2,
    conflicts: [],
    mergeNote: null,
    diff: '',
    diffChars: 0,
    isDiffTruncated: false,
  }
  const levels = new Map(runChecks(facts).map(check => [check.id, check.level]))
  expect(levels.get('conflicts')).toBe('ok')
  expect(levels.get('secrets')).toBe('ok')
  expect(levels.get('lockfiles')).toBe('warn')
  expect(levels.get('migrations')).toBe('warn')
  expect(levels.get('binaries')).toBe('warn')
  expect(levels.get('merges')).toBe('warn')
  expect(levels.get('tests')).toBe('ok')
  expect(levels.has('behind')).toBe(false)

  expect(parseFinding({ file: 'a.ts', line: '12', severity: 'low', category: 'tests', title: 't', detail: 'd' })).toEqual({
    file: 'a.ts',
    line: 12,
    severity: 'low',
    category: 'tests',
    title: 't',
    detail: 'd',
    suggestion: null,
  })
  expect(parseFinding({ file: 'a.ts', severity: 'low', category: 'style', title: 't', detail: 'd' })).toContain('category must be one of')
})

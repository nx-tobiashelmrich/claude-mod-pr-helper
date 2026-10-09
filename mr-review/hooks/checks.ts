import type { Check, CheckLevel } from '../types'
import { LOCKFILE } from './collect'
import type { Facts } from './collect'

export type AddedLine = { file: string; line: number; text: string }

type Pattern = { name: string; re: RegExp }

const MAX_HITS = 6

const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/
const ENV_FILE_OK = /\.env\.(example|sample|template|dist)$/
const MIGRATION = /(^|\/)(migrations?|migrate|db\/migrate|alembic\/versions)\/|\.sql$/i
const INFRA = /(^|\/)(\.gitlab-ci\.yml|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Jenkinsfile|bitbucket-pipelines\.yml|[^/]+\.tf)$|(^|\/)(\.github\/workflows|\.circleci|helm|k8s|kubernetes|terraform)\//
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__|spec|specs)\//i
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|php|cs|swift|scala|vue|svelte)$/i
const PYTHON_FILE = /\.py$/i

const SECRETS: Pattern[] = [
  {
    name: 'credential assigned a literal',
    re: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|secret|passw(?:or)?d|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
  },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
]

const DANGER: Pattern[] = [
  { name: 'eval / new Function', re: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  { name: 'raw HTML injection', re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\binsertAdjacentHTML\s*\(|v-html=|\{@html/ },
  {
    name: 'shell command built from data',
    re: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{|\bshell\s*=\s*True\b|\bos\.system\s*\(|\bsubprocess\.(?:call|run|Popen)\s*\([^)]*\+|\bsystem\s*\(\s*["'][^"']*["']\s*[.+]/,
  },
  {
    name: 'TLS verification disabled',
    re: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/i,
  },
  {
    name: 'unsafe deserialization',
    re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader)|\bunserialize\s*\(|\bMarshal\.load\b|ObjectInputStream/,
  },
  {
    name: 'permissive CORS',
    re: /Access-Control-Allow-Origin['"]?\s*[:,=]\s*['"]\*['"]|cors\(\s*\{\s*origin\s*:\s*(?:['"]\*['"]|true)/,
  },
  { name: 'world-writable permissions', re: /\bchmod\s+(?:-R\s+)?0?777\b|\b0o?777\b/ },
  {
    name: 'weak hash near a secret',
    re: /\b(?:md5|sha1)\b[^\n]*(?:password|passwd|token|secret)|(?:password|passwd|token|secret)[^\n]*\b(?:md5|sha1)\b/i,
  },
  {
    name: 'auth or CSRF check switched off',
    re: /\b(?:auth|authenticate|authorize|csrf|verify)[A-Za-z_]*\s*[:=]\s*false\b|@csrf_exempt|skip_before_action\s+:(?:authenticate|verify)/i,
  },
]

const SQL_INTERPOLATION: Pattern[] = [
  {
    name: 'SQL built with string interpolation or concatenation',
    re: /\b(?:select|insert\s+into|update|delete\s+from|where|order\s+by)\b[^\n]*?(?:\$\{|["']\s*\+\s*[A-Za-z_$]|\+\s*["']|%s|%\(|\.format\()/i,
  },
  { name: 'SQL in an f-string', re: /\bf["'][^"'\n]*\b(?:select|insert|update|delete)\b/i },
]

const DEBUG: Pattern[] = [
  { name: 'console output', re: /\bconsole\.(?:log|debug|trace|dir)\s*\(/ },
  { name: 'debugger statement', re: /^\s*debugger\b/ },
  { name: 'focused test', re: /\b(?:it|test|describe|context)\.only\s*\(|\bf(?:it|describe)\s*\(/ },
  { name: 'skipped test', re: /\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip|@Ignore\b|@Disabled\b/ },
  { name: 'debug breakpoint', re: /\bbinding\.pry\b|\bbyebug\b|\bbreakpoint\(\)|\bpdb\.set_trace\(\)|\bvar_dump\(|\bdd\(/ },
]

const PRINT = /^\s*print\s*\(/
const TODO = /\b(?:TODO|FIXME|HACK|XXX)\b/
const WIP_SUBJECT = /^(?:wip\b|fixup!|squash!|tmp\b|temp\b|\.+$|asdf\b|foo\b)/i
/** A bare "fix", "fix stuff" or "test" is unfinished work; "fix(links): …" and "fix: …" are conventional commits. */
const BARE_FIX = /^(?:fix|fixes|test|tests|update|updates|changes|stuff|misc)\b(?![(:!])/i

export function isWipSubject(subject: string): boolean {
  const trimmed = subject.trim()
  if (WIP_SUBJECT.test(trimmed)) return true

  return BARE_FIX.test(trimmed) && trimmed.split(/\s+/).length <= 3
}

/** The lines a unified diff adds, each with the file and its line number on the new side. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = []
  let file = ''
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const named = raw.slice(4).trim()
      file = named === '/dev/null' ? '' : named.replace(/^b\//, '')
      continue
    }
    if (raw.startsWith('--- ')) continue
    if (raw.startsWith('@@')) {
      const hunk = /\+(\d+)/.exec(raw)
      line = hunk === null ? 0 : Number(hunk[1])
      continue
    }
    if (raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1) })
      line += 1
      continue
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue
    if (/^(diff --git|index |new file|deleted file|similarity|rename |Binary|old mode|new mode)/.test(raw)) continue
    line += 1
  }

  return out
}

export function runChecks(facts: Facts): Check[] {
  const checks: Check[] = []
  const lines = addedLines(facts.diff)
  const push = (id: string, level: CheckLevel, title: string, detail: string | null = null) =>
    checks.push({ id, level, title, detail })
  const hits = (patterns: Pattern[], keep: (line: AddedLine) => boolean = () => true): string[] => {
    const found: string[] = []
    for (const added of lines) {
      if (!keep(added)) continue
      for (const pattern of patterns) {
        if (pattern.re.test(added.text)) {
          found.push(`${added.file}:${added.line} ${pattern.name}`)
          break
        }
      }
    }

    return found
  }
  const list = (items: string[]) =>
    items.slice(0, MAX_HITS).join('\n') + (items.length > MAX_HITS ? `\n… and ${items.length - MAX_HITS} more` : '')
  const paths = (items: { path: string }[]) => list(items.map(item => item.path))

  if (facts.conflicts.length > 0) {
    push('conflicts', 'fail', `merge conflicts in ${facts.conflicts.length} file${facts.conflicts.length === 1 ? '' : 's'}`, list(facts.conflicts))
  } else if (facts.mergeNote !== null) {
    push('conflicts', 'warn', 'merge check unavailable', facts.mergeNote)
  } else {
    push('conflicts', 'ok', `merges cleanly into ${facts.targetRef}`)
  }
  if (facts.behind > 0) {
    push('behind', 'warn', `${facts.behind} commit${facts.behind === 1 ? '' : 's'} behind ${facts.targetRef}`, 'rebase or merge the target so CI tests the real result')
  }

  const secrets = hits(SECRETS)
  if (secrets.length > 0) push('secrets', 'fail', `${secrets.length} secret-looking value${secrets.length === 1 ? '' : 's'} added`, list(secrets))
  else push('secrets', 'ok', 'no secret-looking values in added lines')

  const envFiles = facts.files.filter(file => ENV_FILE.test(file.path) && !ENV_FILE_OK.test(file.path))
  if (envFiles.length > 0) push('env-files', 'fail', 'environment file committed', paths(envFiles))

  const danger = hits(DANGER)
  if (danger.length > 0) push('danger', 'warn', `${danger.length} risky call${danger.length === 1 ? '' : 's'} added`, list(danger))

  const sql = hits(SQL_INTERPOLATION)
  if (sql.length > 0) push('sql', 'warn', `${sql.length} SQL statement${sql.length === 1 ? '' : 's'} built from strings`, list(sql))

  const debug = [...hits(DEBUG), ...hits([{ name: 'print call', re: PRINT }], added => PYTHON_FILE.test(added.file))]
  if (debug.length > 0) push('debug', 'warn', `${debug.length} debug leftover${debug.length === 1 ? '' : 's'}`, list(debug))
  else push('debug', 'ok', 'no debug leftovers in added lines')

  const todos = hits([{ name: 'marker', re: TODO }])
  if (todos.length > 0) push('todo', 'warn', `${todos.length} TODO/FIXME marker${todos.length === 1 ? '' : 's'} added`, list(todos))

  const lockfiles = facts.files.filter(file => LOCKFILE.test(file.path))
  if (lockfiles.length > 0) push('lockfiles', 'warn', 'dependency lockfile changed', paths(lockfiles))

  const migrations = facts.files.filter(file => MIGRATION.test(file.path))
  if (migrations.length > 0) push('migrations', 'warn', 'database migration or SQL touched', paths(migrations))

  const infra = facts.files.filter(file => INFRA.test(file.path))
  if (infra.length > 0) push('infra', 'warn', 'CI or infrastructure files touched', paths(infra))

  const binaries = facts.files.filter(file => file.isBinary)
  if (binaries.length > 0) push('binaries', 'warn', `${binaries.length} binary file${binaries.length === 1 ? '' : 's'} changed`, paths(binaries))
  const bigFiles = facts.files.filter(file => file.added > 800)
  if (bigFiles.length > 0) push('big-files', 'warn', 'files with more than 800 added lines', list(bigFiles.map(file => `${file.path} (+${file.added})`)))

  // Deleted lines are cheap to review, so size goes by what was added.
  if (facts.insertions > 800 || facts.files.length > 40) {
    push('size', 'warn', `large change: ${facts.files.length} files, +${facts.insertions} −${facts.deletions}`, 'consider splitting; big merge requests hide defects')
  }

  const wip = facts.commits.filter(commit => isWipSubject(commit.subject))
  if (wip.length > 0) push('commits', 'warn', `${wip.length} WIP or fixup commit${wip.length === 1 ? '' : 's'}`, list(wip.map(commit => `${commit.hash} ${commit.subject}`)))
  if (facts.mergeCommits > 0) push('merges', 'warn', `${facts.mergeCommits} merge commit${facts.mergeCommits === 1 ? '' : 's'} in the branch`, 'rebase for a linear history if your team squashes or rebases')

  const code = facts.files.filter(file => CODE_FILE.test(file.path) && !TEST_FILE.test(file.path))
  const tests = facts.files.filter(file => TEST_FILE.test(file.path))
  if (code.length > 0 && tests.length === 0) push('tests', 'warn', 'code changed without test changes', paths(code))
  else if (code.length > 0) push('tests', 'ok', `${tests.length} test file${tests.length === 1 ? '' : 's'} changed`)

  if (facts.isDiffTruncated) {
    push('diff-size', 'warn', 'diff cut for the model', `${facts.diffChars} characters; the model reads the first ${facts.diff.length} and must use git for the rest`)
  }
  if (facts.diffNotes.length > 0) push('diff-pruned', 'ok', `${facts.diffNotes.length} file${facts.diffNotes.length === 1 ? '' : 's'} left out of the diff handed to the model`, list(facts.diffNotes))

  const rank: Record<CheckLevel, number> = { fail: 0, warn: 1, ok: 2 }

  return checks.sort((a, b) => rank[a.level] - rank[b.level])
}

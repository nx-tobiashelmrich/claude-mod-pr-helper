import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Category, CheckLevel, Finding, Review, Severity, Verdict } from '../types'
import { runChecks } from './checks'
import { collectFacts, collectMr, gitRunner, str } from './collect'
import type { Runner } from './collect'
import {
  buildBrief,
  buildMarkdown,
  countBySeverity,
  diffContext,
  location,
  statusLine,
  summaryText,
  visiblePrompt,
} from './report'

const PANE = 'mr-review'

const review = atom({ plugin: 'mr-review', key: 'review' } as const, null)
const findings = atom({ plugin: 'mr-review', key: 'findings' } as const, [])
const selected = atom({ plugin: 'mr-review', key: 'selected' } as const, null)

const SEVERITY: Severity[] = ['high', 'medium', 'low']
const CATEGORY: Category[] = ['security', 'performance', 'correctness', 'merge', 'tests', 'maintainability']

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Path relative to the repository root' },
    line: {
      type: 'integer',
      description: 'Line number on the new side of the diff; leave out when the finding is not tied to one line',
    },
    severity: { type: 'string', enum: SEVERITY, description: 'high: fix before merging; medium: should fix; low: worth doing' },
    category: { type: 'string', enum: CATEGORY },
    title: { type: 'string', description: 'One line, under 80 characters' },
    detail: { type: 'string', description: 'What is wrong and why it matters, citing the code' },
    suggestion: { type: 'string', description: 'The concrete change that fixes it' },
  },
  required: ['file', 'severity', 'category', 'title', 'detail'],
}

const DONE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ready', 'needs-work', 'blocked'] },
    summary: { type: 'string', description: 'Two to three sentences, as you would write them on the merge request' },
  },
  required: ['verdict', 'summary'],
}

const HELP = [
  '/mr-review [target] [--repo <path>] [--no-fetch]   review HEAD against the target branch (default from config, or the MR)',
  '/mr-review report                                  print the review as markdown for the merge request page',
  '/mr-review open | close | clear                    show or hide the pane, or forget the review',
].join('\n')

type Sub = 'review' | 'report' | 'open' | 'close' | 'clear' | 'help'
export type Args = { sub: Sub; target: string | null; repo: string | null; fetch: boolean | null }
export type Config = { target: string; remote: string; fetch: boolean }

export function parseArgs(text: string): Args {
  const tokens = text.trim().split(/\s+/).filter(token => token !== '')
  const args: Args = { sub: 'review', target: null, repo: null, fetch: null }
  const first = tokens[0]
  if (first === 'report' || first === 'open' || first === 'close' || first === 'clear' || first === 'help') {
    args.sub = first

    return args
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    if (token === '--no-fetch') args.fetch = false
    else if (token === '--fetch') args.fetch = true
    else if (token.startsWith('--repo=')) args.repo = token.slice('--repo='.length)
    else if (token === '--repo') {
      args.repo = tokens[i + 1] ?? null
      i += 1
    } else if (token.startsWith('--target=')) args.target = token.slice('--target='.length)
    else if (token === '--target') {
      args.target = tokens[i + 1] ?? null
      i += 1
    } else if (!token.startsWith('-') && args.target === null) args.target = token
  }

  return args
}

function blank(args: string, cwd: string, startedAt: number): Review {
  return {
    status: 'collecting',
    args,
    startedAt,
    cwd,
    root: cwd,
    branch: '…',
    target: '…',
    targetRef: '',
    isTargetFetched: false,
    base: '',
    behind: 0,
    commits: [],
    files: [],
    insertions: 0,
    deletions: 0,
    diffChars: 0,
    isDiffTruncated: false,
    conflicts: [],
    checks: [],
    mr: null,
    verdict: null,
    error: null,
  }
}

function isSeverity(value: string | null): value is Severity {
  return value !== null && (SEVERITY as string[]).includes(value)
}

function isCategory(value: string | null): value is Category {
  return value !== null && (CATEGORY as string[]).includes(value)
}

const VERDICTS: Verdict['kind'][] = ['ready', 'needs-work', 'blocked']

function isVerdict(value: string | null): value is Verdict['kind'] {
  return value !== null && (VERDICTS as string[]).includes(value)
}

export function parseFinding(input: Record<string, unknown>): Omit<Finding, 'id' | 'isDismissed'> | string {
  const file = (str(input, 'file') ?? '').trim()
  const title = (str(input, 'title') ?? '').trim()
  const detail = (str(input, 'detail') ?? '').trim()
  const severity = str(input, 'severity')
  const category = str(input, 'category')
  if (file === '') return 'file is required'
  if (title === '') return 'title is required'
  if (detail === '') return 'detail is required'
  if (!isSeverity(severity)) return `severity must be one of ${SEVERITY.join(', ')}`
  if (!isCategory(category)) return `category must be one of ${CATEGORY.join(', ')}`
  const rawLine = input.line
  const line =
    typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine > 0
      ? rawLine
      : typeof rawLine === 'string' && /^\d+$/.test(rawLine)
        ? Number(rawLine)
        : null
  const suggestion = (str(input, 'suggestion') ?? '').trim()

  return { file, line, severity, category, title: title.slice(0, 160), detail, suggestion: suggestion === '' ? null : suggestion }
}

const SEVERITY_COLOR: Record<Severity, string> = { high: 'error', medium: 'warning', low: 'text' }
const CHECK_COLOR: Record<CheckLevel, string> = { fail: 'error', warn: 'warning', ok: 'success' }
const CHECK_GLYPH: Record<CheckLevel, string> = { fail: '✗', warn: '!', ok: '✓' }
const VERDICT_COLOR = { ready: 'success', 'needs-work': 'warning', blocked: 'error' } as const

function cut(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

function runner($: EngineInterface): Runner {
  return (argv, init) => $.process.run(argv, init)
}

async function refreshStatus($: EngineInterface) {
  $.ui.status(statusLine(await read($, review), await read($, findings)))
}

async function startReview($: EngineInterface, config: Config, rawArgs: string, args: Args) {
  const cwd = args.repo ?? (await $.session.cwd())
  const startedAt = await $.clock.now()
  await update($, review, () => blank(rawArgs, cwd, startedAt))
  await update($, findings, () => [])
  await update($, selected, () => null)
  await $.ui.open({ id: PANE, title: 'MR review' })
  await refreshStatus($)

  const run = runner($)
  const mr = await collectMr(run, cwd)
  const target = args.target ?? mr?.target ?? config.target
  const facts = await collectFacts(gitRunner(run, cwd), {
    target,
    remote: config.remote,
    fetch: args.fetch ?? config.fetch,
  })
  if ('error' in facts) {
    await update($, review, current => ({
      ...(current ?? blank(rawArgs, cwd, startedAt)),
      status: 'error' as const,
      error: facts.error,
    }))
    await refreshStatus($)

    return { text: facts.error }
  }

  const started: Review = {
    status: 'reviewing',
    args: rawArgs,
    startedAt,
    cwd,
    root: facts.root,
    branch: facts.branch,
    target,
    targetRef: facts.targetRef,
    isTargetFetched: facts.isTargetFetched,
    base: facts.base,
    behind: facts.behind,
    commits: facts.commits,
    files: facts.files,
    insertions: facts.insertions,
    deletions: facts.deletions,
    diffChars: facts.diffChars,
    isDiffTruncated: facts.isDiffTruncated,
    conflicts: facts.conflicts,
    checks: runChecks(facts),
    mr,
    verdict: null,
    error: null,
  }
  await update($, review, () => started)
  await refreshStatus($)

  await $.tool.register({
    name: 'finding',
    description:
      'Records one merge request review finding in the MR review pane. Call it once per finding while reviewing; findings only written in prose do not reach the pane.',
    inputSchema: FINDING_SCHEMA,
    isDeferred: false,
  })
  await $.tool.register({
    name: 'done',
    description: 'Closes the merge request review with a verdict and a short summary. Call it once, after the last finding.',
    inputSchema: DONE_SCHEMA,
    isDeferred: false,
  })
  // A prompt cannot be submitted from inside the command's own hook (it would
  // wait on the turn the hook holds), so the brief goes out once it has returned.
  const diff = facts.diff
  $.clock.after(0, () => {
    void deliver($, started, diff)
  })

  return { text: summaryText(started) }
}

/**
 * Hands the model the brief and the diff as hidden user rows (read by the model,
 * never shown as typed), then starts the review turn with a short visible prompt.
 * Where a row is refused, the brief rides in the prompt text instead.
 */
async function deliver($: EngineInterface, started: Review, diff: string) {
  try {
    const rows = [buildBrief(started), diffContext(started, diff)]
    let isHidden = true
    for (const text of rows) {
      const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (appended.deny !== undefined) {
        $.ui.log(`a brief row was refused (${appended.deny}); sending it in the prompt instead`, { to: 'debug' })
        isHidden = false
        break
      }
    }
    const text = isHidden ? visiblePrompt(started) : `${visiblePrompt(started)}\n\n${rows.join('\n\n')}`
    await $.prompt.submit({ text })
  } catch (error) {
    $.ui.log(`the review prompt was not submitted: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function explain($: EngineInterface, finding: Finding) {
  void $.prompt.submit({
    text:
      `Explain MR review finding ${finding.id} in more depth: "${finding.title}" at ${location(finding)}. ` +
      'Show the relevant code, say why it matters here and how you would verify it. Do not change any files.',
  })
}

function fix($: EngineInterface, finding: Finding) {
  void $.prompt.submit({
    text:
      `Fix MR review finding ${finding.id}: "${finding.title}" at ${location(finding)}. ` +
      (finding.suggestion === null ? '' : `Suggested change: ${finding.suggestion}. `) +
      'Apply the change in the working tree, run the tests that cover it if there are any, and summarise what you changed.',
  })
}

async function dismiss($: EngineInterface, id: string) {
  await update($, findings, list => list.map(finding => (finding.id === id ? { ...finding, isDismissed: true } : finding)))
  await update($, selected, current => (current === id ? null : current))
  await refreshStatus($)
}

async function copyReport($: EngineInterface, surface: RenderSurface) {
  const current = await read($, review)
  if (current === null) return
  const copied = await $.ui.copy({ text: buildMarkdown(current, await read($, findings)), surface })
  $.ui.toast(copied.isCopied ? 'MR review report copied as markdown' : `report not copied: ${copied.reason}`)
}

/**
 * `$.command.run` runs through every hook but the calling plugin's own, so the
 * pane cannot re-run /mr-review through the command; it starts the review itself.
 */
function rerun($: EngineInterface, config: Config, args: string) {
  void startReview($, config, args, parseArgs(args))
}

function closePane($: EngineInterface) {
  void $.ui.close({ id: PANE })
}

export const register: Register = (on, options) => {
  const config: Config = {
    target: typeof options.targetBranch === 'string' && options.targetBranch.trim() !== '' ? options.targetBranch.trim() : 'develop',
    remote: typeof options.remote === 'string' && options.remote.trim() !== '' ? options.remote.trim() : 'origin',
    fetch: options.fetch !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mr-review',
      description: 'Review the checked-out branch as a merge request: conflicts, pre-checks and findings in a pane',
      argumentHint: '[target] [--repo <path>] [--no-fetch] | report | open | close | clear',
    })

    return next(e)
  })

  on('command.run', { command: 'mr-review' }, async ($, e) => {
    const args = parseArgs(e.args)
    switch (args.sub) {
      case 'help':
        return { text: HELP }
      case 'open': {
        await $.ui.open({ id: PANE, title: 'MR review' })

        return { text: 'MR review pane opened.' }
      }
      case 'close': {
        await $.ui.close({ id: PANE })

        return { text: 'MR review pane closed.' }
      }
      case 'clear': {
        await update($, review, () => null)
        await update($, findings, () => [])
        await update($, selected, () => null)
        $.ui.status(undefined)
        await $.ui.close({ id: PANE })

        return { text: 'MR review cleared.' }
      }
      case 'report': {
        const current = await read($, review)
        if (current === null) return { text: 'No review yet. Run /mr-review first.' }

        return { text: buildMarkdown(current, await read($, findings)) }
      }
      default:
        return startReview($, config, e.args, args)
    }
  })

  on('tool.check', { tool: 'mcp__mr-review__finding' }, () => ({
    decision: 'allow' as const,
    reason: 'mr-review records its own findings; nothing leaves the pane',
  })).catch(($, e, next) => (next.called ? next(e) : { decision: 'ask' as const }))

  on('tool.check', { tool: 'mcp__mr-review__done' }, () => ({
    decision: 'allow' as const,
    reason: 'mr-review records its own verdict; nothing leaves the pane',
  })).catch(($, e, next) => (next.called ? next(e) : { decision: 'ask' as const }))

  on('tool.call', { tool: 'mcp__mr-review__finding' }, async ($, e) => {
    const parsed = parseFinding(e as unknown as Record<string, unknown>)
    if (typeof parsed === 'string') return { deny: `mr-review: ${parsed}` }
    let id = ''
    await update($, findings, list => {
      id = `F${list.length + 1}`

      return [...list, { ...parsed, id, isDismissed: false }]
    })
    const list = await read($, findings)
    await refreshStatus($)

    return {
      result: `Recorded ${id} (${parsed.severity}, ${parsed.category}) at ${location(parsed)}: ${parsed.title}. ${list.length} finding(s) so far.`,
    }
  })

  on('tool.call', { tool: 'mcp__mr-review__done' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const kind = str(input, 'verdict')
    const summary = (str(input, 'summary') ?? '').trim()
    if (!isVerdict(kind)) return { deny: 'mr-review: verdict must be ready, needs-work or blocked' }
    if (summary === '') return { deny: 'mr-review: summary is required' }
    await update($, review, current =>
      current === null ? null : { ...current, status: 'done' as const, verdict: { kind, summary } },
    )
    const list = await read($, findings)
    await refreshStatus($)
    const counts = countBySeverity(list)
    $.ui.toast(`MR review: ${kind} · ${counts.high} high, ${counts.medium} medium, ${counts.low} low`)

    return { result: `Verdict recorded: ${kind}. ${list.length} finding(s) are in the pane. Now give the person a short recap.` }
  })

  on('turn.complete', async ($, e, next) => {
    const current = await read($, review)
    if (current !== null && current.status === 'reviewing') {
      await update($, review, latest =>
        latest === null || latest.status !== 'reviewing' ? latest : { ...latest, status: 'done' as const },
      )
      await refreshStatus($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'mr-review' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, review)
    const list = await read($, findings)
    const chosen = await read($, selected)
    const width = Math.max(24, e.props.bodyColumns)

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No review yet. Check out a merge request branch and run /mr-review.</Text>
        </Box>
      )
    }
    if (current.status === 'collecting') {
      return (
        <Box flexDirection="column">
          <Text>Collecting facts in {current.cwd}…</Text>
        </Box>
      )
    }
    if (current.status === 'error') {
      return (
        <Box flexDirection="column">
          <Text color="error">✗ {current.error ?? 'the review failed'}</Text>
          <Box marginTop={1} gap={1}>
            <Button key="rerun" hotkey="r" label="re-run" onPress={() => rerun($, config, current.args)} />
            <Button key="close" hotkey="x" label="close" role="dismiss" onPress={() => closePane($)} />
          </Box>
        </Box>
      )
    }

    const open = list.filter(finding => !finding.isDismissed)
    const counts = countBySeverity(list)
    const statusWord = current.status === 'reviewing' ? 'reviewing…' : current.verdict === null ? 'done' : current.verdict.kind
    const summary =
      `${current.commits.length} commit${current.commits.length === 1 ? '' : 's'} · ` +
      `${current.files.length} file${current.files.length === 1 ? '' : 's'} · +${current.insertions} −${current.deletions}` +
      (current.behind > 0 ? ` · ${current.behind} behind ${current.target}` : '')

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{current.branch}</Text>
          <Text dimColor> → </Text>
          <Text bold>{current.target}</Text>
          <Text dimColor> · {statusWord}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{summary}</Text>
        {current.mr !== null && (
          <Text wrap="truncate-end">
            {cut(`${current.mr.number} ${current.mr.title}${current.mr.author === null ? '' : ` · ${current.mr.author}`}${current.mr.checks === null ? '' : ` · ${current.mr.checks}`}`, width)}
          </Text>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Pre-checks</Text>
          {current.checks.map(check => (
            <Box flexDirection="column">
              <Box>
                <Text color={CHECK_COLOR[check.level]}>{CHECK_GLYPH[check.level]} </Text>
                <Text wrap="truncate-end" dimColor={check.level === 'ok'}>
                  {check.title}
                </Text>
              </Box>
              {check.level !== 'ok' &&
                check.detail !== null &&
                check.detail
                  .split('\n')
                  .slice(0, 3)
                  .map(line => (
                    <Text dimColor wrap="truncate-end">
                      {cut(`   ${line}`, width)}
                    </Text>
                  ))}
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold>Findings ({String(open.length)})</Text>
            <Text dimColor>{`  ${counts.high} high · ${counts.medium} medium · ${counts.low} low`}</Text>
          </Box>
          {current.status === 'reviewing' && open.length === 0 && <Text dimColor>Claude is reading the diff…</Text>}
          {current.status === 'done' && open.length === 0 && <Text color="success">No findings.</Text>}
          {open.map((finding, index) => {
            const isChosen = chosen === finding.id

            return (
              <Box flexDirection="column">
                <Button
                  key={`sel:${finding.id}`}
                  plain
                  {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                  onPress={() => update($, selected, current => (current === finding.id ? null : finding.id))}
                >
                  {isChosen ? '▾ ' : '▸ '}
                  <Text color={SEVERITY_COLOR[finding.severity]} bold={finding.severity === 'high'}>
                    {finding.severity.toUpperCase().padEnd(6)}
                  </Text>
                  {` ${finding.category.padEnd(15)} `}
                  {cut(finding.title, Math.max(12, width - 30))}
                </Button>
                <Text dimColor wrap="truncate-end">
                  {cut(`     ${location(finding)}`, width)}
                </Text>
                {isChosen && (
                  <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
                    <Text wrap="wrap">{finding.detail}</Text>
                    {finding.suggestion !== null && (
                      <Text dimColor wrap="wrap">
                        {`Suggestion: ${finding.suggestion}`}
                      </Text>
                    )}
                    <Box gap={1}>
                      <Button key={`explain:${finding.id}`} hotkey="e" label="explain" onPress={() => explain($, finding)} />
                      <Button key={`fix:${finding.id}`} hotkey="f" label="fix" onPress={() => fix($, finding)} />
                      <Button key={`dismiss:${finding.id}`} hotkey="d" label="dismiss" onPress={() => dismiss($, finding.id)} />
                    </Box>
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>

        {current.verdict !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={VERDICT_COLOR[current.verdict.kind]}>
              Verdict: {current.verdict.kind}
            </Text>
            <Text wrap="wrap">{current.verdict.summary}</Text>
          </Box>
        )}

        <Box gap={1} marginTop={1}>
          <Button key="rerun" hotkey="r" label="re-run" onPress={() => rerun($, config, current.args)} />
          <Button key="copy" hotkey="c" label="copy report" onPress={press => copyReport($, press.surface)} />
          <Button key="close" hotkey="x" label="close" role="dismiss" onPress={() => closePane($)} />
        </Box>
        <Text dimColor wrap="truncate-end">
          {cut('1-9 select · e explain · f fix · d dismiss · r re-run · c copy · x close (ctrl+x tab focuses the pane)', width)}
        </Text>
      </Box>
    )
  })
}

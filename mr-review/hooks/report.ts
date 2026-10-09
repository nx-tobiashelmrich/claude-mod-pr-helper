import type { Finding, Review, Severity } from '../types'

export const SEVERITIES: Severity[] = ['high', 'medium', 'low']

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
  for (const finding of findings) if (!finding.isDismissed) counts[finding.severity] += 1

  return counts
}

export function statusLine(review: Review | null, findings: readonly Finding[]): string | undefined {
  if (review === null) return undefined
  if (review.status === 'collecting') return 'mr-review: collecting facts…'
  if (review.status === 'error') return `mr-review: ${review.error ?? 'failed'}`
  const counts = countBySeverity(findings)
  const parts = SEVERITIES.filter(severity => counts[severity] > 0).map(severity => `${counts[severity]} ${severity}`)
  const tally = parts.length === 0 ? 'no findings yet' : parts.join(' · ')
  if (review.status === 'reviewing') return `mr-review: reviewing ${review.branch} → ${review.target} · ${tally}`
  const verdict = review.verdict === null ? 'done' : review.verdict.kind

  return `mr-review: ${verdict} · ${tally}`
}

export function location(finding: Pick<Finding, 'file' | 'line'>): string {
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}`
}

const CHECK_GLYPH = { fail: '✗', warn: '!', ok: '✓' } as const

export function summaryText(review: Review): string {
  const lines = [
    `mr-review: ${review.branch} → ${review.target} (${review.targetRef}${review.isTargetFetched ? ', fetched' : ', local'})`,
    `${review.commits.length} commit${review.commits.length === 1 ? '' : 's'} · ${review.files.length} file${review.files.length === 1 ? '' : 's'} · +${review.insertions} −${review.deletions}` +
      (review.behind > 0 ? ` · ${review.behind} behind` : ''),
  ]
  if (review.mr !== null) {
    lines.push(`${review.mr.number} "${review.mr.title}"${review.mr.author === null ? '' : ` by ${review.mr.author}`}${review.mr.checks === null ? '' : ` · ${review.mr.checks}`}`)
  }
  for (const check of review.checks) {
    if (check.level === 'ok') continue
    lines.push(`${CHECK_GLYPH[check.level]} ${check.title}${check.detail === null ? '' : `: ${check.detail.split('\n')[0] ?? ''}`}`)
  }
  lines.push('Claude is reviewing the diff now; findings land in the "MR review" pane as they are found.')

  return lines.join('\n')
}

export function visiblePrompt(review: Review): string {
  return (
    `Review merge request branch \`${review.branch}\` → \`${review.target}\` ` +
    `(${review.commits.length} commits, ${review.files.length} files, +${review.insertions} −${review.deletions}). ` +
    'The brief and the full diff are attached as context. Report each finding with the mr-review finding tool, ' +
    'then call the mr-review done tool with a verdict.'
  )
}

export function buildBrief(review: Review): string {
  const commits = review.commits.map(commit => `- ${commit.hash} ${commit.subject} (${commit.author}, ${commit.age})`)
  const files = review.files.map(file =>
    `- ${file.status} ${file.path}${file.isBinary ? ' (binary)' : ` (+${file.added} −${file.removed})`}`,
  )
  const checks = review.checks.map(check =>
    `- ${check.level.toUpperCase()} ${check.title}${check.detail === null ? '' : `\n    ${check.detail.replace(/\n/g, '\n    ')}`}`,
  )
  const mr =
    review.mr === null
      ? 'No merge request metadata found (neither glab nor gh answered for this branch).'
      : [
          `${review.mr.number} "${review.mr.title}" on ${review.mr.source}` +
            (review.mr.author === null ? '' : ` by ${review.mr.author}`) +
            (review.mr.state === null ? '' : ` · ${review.mr.state}`) +
            (review.mr.checks === null ? '' : ` · ${review.mr.checks}`),
          review.mr.url,
          review.mr.description === null || review.mr.description.trim() === ''
            ? '(no description)'
            : `Description:\n${review.mr.description.trim()}`,
        ].join('\n')

  return [
    '# Merge request review brief (from the mr-review plugin)',
    '',
    `Repository root: ${review.root}`,
    `Branch under review: ${review.branch}`,
    `Target: ${review.target} (compared against ${review.targetRef}, ${review.isTargetFetched ? 'fetched just now' : 'local copy, fetch skipped or failed'})`,
    `Merge base: ${review.base}`,
    `Behind target by ${review.behind} commit(s).`,
    review.conflicts.length === 0
      ? 'Merge check: merges cleanly.'
      : `Merge check: CONFLICTS in ${review.conflicts.join(', ')}.`,
    '',
    `## Commits (${review.commits.length})`,
    ...(commits.length === 0 ? ['- none'] : commits),
    '',
    `## Files (${review.files.length}, +${review.insertions} −${review.deletions})`,
    ...(files.length === 0 ? ['- none'] : files),
    '',
    '## Merge request metadata',
    mr,
    '',
    '## Automated pre-checks (pattern matches, unverified)',
    ...checks,
    '',
    '## Your task',
    `Review this merge request the way a careful senior reviewer would before it merges into ${review.target}. Look for, in this order:`,
    '1. Merge blockers: conflicts, being behind the target, unfinished work (WIP or fixup commits), broken builds or tests.',
    '2. Security: injection (SQL, shell, HTML/XSS, path), missing authentication or authorization, secrets in code, disabled TLS or weak crypto, unsafe deserialization, SSRF, sensitive data in logs.',
    '3. Performance: N+1 queries, unbounded queries or loops, missing pagination or indexes, synchronous I/O on hot paths, memory growth, needless work on the request path.',
    '4. Correctness: error handling, null and undefined, races, off-by-one, broken contracts between callers and callees, missing migrations or config.',
    '5. Tests and maintainability: new behaviour without tests, dead code, debug leftovers, misleading names.',
    '',
    'Rules:',
    '- Start from the diff below. Read surrounding code with your tools when a judgment depends on it (callers, existing helpers, how parameters are escaped). Paths in the diff are relative to the repository root above; use absolute paths when it differs from your working directory.',
    '- Report EVERY finding by calling the `mcp__mr-review__finding` tool once per finding: file, line (on the new side of the diff), severity, category, a one-line title, a detail that cites the code, and a concrete suggestion. Findings only mentioned in prose do not reach the review pane.',
    '- Severity: high = must be fixed before merging; medium = should be fixed; low = worth doing.',
    '- The pre-checks above are regex matches. Verify each in the code; report the real ones as findings too, so the pane holds everything, and ignore the false positives.',
    '- Skip style nits unless they hide a defect. Do not edit files during the review.',
    '- When done, call `mcp__mr-review__done` with a verdict (ready, needs-work or blocked) and a two to three sentence summary, then give the person a short recap in prose.',
    '',
    review.isDiffTruncated
      ? `The diff (${review.diffChars} characters) was cut after the first part; run \`git diff ${review.base} HEAD\` for the rest.`
      : '',
  ].join('\n')
}

export function diffContext(review: Review, diff: string): string {
  return `## Diff ${review.base}..HEAD (${review.branch})\n\n\`\`\`diff\n${diff}\n\`\`\``
}

export function buildMarkdown(review: Review, findings: readonly Finding[]): string {
  const counts = countBySeverity(findings)
  const open = findings.filter(finding => !finding.isDismissed)
  const dismissed = findings.filter(finding => finding.isDismissed)
  const section = (finding: Finding) =>
    [
      `### ${finding.id} · ${finding.severity.toUpperCase()} · ${finding.category} · \`${location(finding)}\``,
      '',
      `**${finding.title}**`,
      '',
      finding.detail,
      ...(finding.suggestion === null ? [] : ['', `_Suggestion:_ ${finding.suggestion}`]),
      '',
    ].join('\n')

  return [
    `# MR review: ${review.branch} → ${review.target}`,
    '',
    `Compared against ${review.targetRef} (merge base ${review.base}). ` +
      `${review.commits.length} commits, ${review.files.length} files, +${review.insertions} −${review.deletions}` +
      (review.behind > 0 ? `, ${review.behind} behind` : '') +
      '.',
    review.mr === null ? '' : `${review.mr.number} "${review.mr.title}" ${review.mr.url}`,
    '',
    review.conflicts.length === 0 ? '**Merge:** clean' : `**Merge:** conflicts in ${review.conflicts.map(path => `\`${path}\``).join(', ')}`,
    '',
    '## Pre-checks',
    '',
    ...review.checks.map(check => `- ${CHECK_GLYPH[check.level]} ${check.title}${check.detail === null ? '' : `: ${check.detail.replace(/\n/g, ', ')}`}`),
    '',
    `## Findings (${open.length}: ${counts.high} high, ${counts.medium} medium, ${counts.low} low)`,
    '',
    ...(open.length === 0 ? ['No findings.', ''] : open.map(section)),
    ...(dismissed.length === 0 ? [] : ['## Dismissed', '', ...dismissed.map(finding => `- ${finding.id} ${finding.title} (\`${location(finding)}\`)`), '']),
    review.verdict === null
      ? '## Verdict\n\nNo verdict given.'
      : `## Verdict: ${review.verdict.kind}\n\n${review.verdict.summary}`,
    '',
  ].join('\n')
}

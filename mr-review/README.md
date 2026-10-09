# mr-review

One slash command that reviews the merge request you have checked out, locally, before you push the button on GitLab or GitHub.

Install it from the marketplace in this repository:

```
/plugin install mr-review --marketplace nx-tobiashelmrich/claude-mod-pr-helper
```

```
/mr-review                 compare HEAD with develop (or the MR's own target), open the pane, start the review
/mr-review main            compare with another target branch
/mr-review --repo ../app   review a checkout somewhere else
/mr-review --no-fetch      skip `git fetch` of the target
/mr-review report          print the review as markdown for the MR page
/mr-review open|close|clear
```

What one run does:

1. Reads MR metadata when `glab` (GitLab) or `gh` (GitHub) is installed and logged in. The MR's target branch wins over the configured default.
2. Fetches the target, finds the merge base, lists commits and files, counts how far behind the target the branch is, and runs `git merge-tree` for a conflict check without touching your working tree.
3. Runs regex pre-checks on the added lines: secrets, env files, SQL built from strings, risky calls (eval, disabled TLS, unsafe deserialization, permissive CORS), debug leftovers, focused tests, WIP commits, lockfiles, migrations, CI files, binaries, size.
4. Opens the "MR review" pane with all of that, registers two tools (`finding`, `done`) and hands Claude a brief plus the full diff as hidden context. Claude reads surrounding code with its own tools and records each finding through the tool, so it lands in the pane as it is found. The `done` tool records the verdict.

In the pane: digits select a finding, `e` asks Claude to explain it, `f` asks Claude to fix it in the working tree, `d` dismisses it, `r` re-runs, `c` copies the markdown report, `x` closes. Focus the pane with ctrl+x tab.

Options (`/config`): `targetBranch` (default `develop`), `remote` (default `origin`), `fetch` (default on).

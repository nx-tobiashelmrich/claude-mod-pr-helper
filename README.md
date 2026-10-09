# claude-mod-pr-helper

Claude Code mods, one folder each, installable from this repository as a marketplace.

## Mods

- [mr-review](mr-review/): one command that reviews the checked-out merge request branch locally. Merge conflicts, regex pre-checks for secrets and risky patterns, and Claude's findings in a live pane with explain, fix and dismiss actions.

## Install

In a Claude Code terminal session:

```
/plugin install mr-review --marketplace nx-tobiashelmrich/claude-mod-pr-helper
```

Answer `y` to add the marketplace, then pick a scope.

## Work on a mod

Run a session with the mod loaded from its folder. The folder is watched, so every save reloads it:

```
claude --plugin-dir ./mr-review
```

Or install it from this folder once and reload after edits with `/reload-plugins`:

```
claude plugin marketplace add .
claude plugin install mr-review@claude-mod-pr-helper
```

Checks before a commit:

```
claude plugin validate mr-review
claude plugin test mr-review
```

Once the engine has loaded the mod it lays the API's type declarations into `mr-review/.claude-plugin/types/` (git-ignored), after which `tsc -p mr-review` type-checks it.

Try it on a throwaway repository with planted problems:

```
mr-review/scripts/make-sample-repo.sh /tmp/mr-sample
cd /tmp/mr-sample
claude --plugin-dir /path/to/claude-mod-pr-helper/mr-review
/mr-review --no-fetch
```

# mend-patch

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/keigorou1999-arch-ai/mend-patch/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/keigorou1999-arch-ai/mend-patch/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write to a tree of text files. It reads four formats:
unified diffs (also with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON.
`SPEC.md` is the whole specification, and `main.ts` follows it sentence by sentence:

- **Three matching tiers.** Old lines are looked for exactly, then with trailing spaces and tabs ignored, then with
  leading ones ignored too; at the last tier the new lines are re-indented to the file. `--strict` keeps to exact matches.
- **Drifted hunks.** A unified hunk goes to the occurrence nearest to its line number, shifted by the hunks before it.
- **Messy patches.** Prose and code fences around a patch, blank context lines without their leading space, CRLF files
  and files without a final line break are all read as the specification says.
- **All or nothing.** Every edit runs against the tree as the earlier edits left it, every failure is reported, and
  files are written only when no edit failed. `--check` prints the same report and writes nothing.
- **Safe paths only.** Absolute paths, `..` segments and backslashes are refused before a file is looked at.

It is a single file for Node 22 with no dependency beyond the standard library, and it reads no clock, no random
number and no directory listing: the same input always gives the same output.

## Run it

```sh
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]   # PATCH absent or -: stdin
node check.ts <path to the kit>/program/generator/practice.json                             # the practice checks
```

Exit 0 lists what changed (`A`, `D`, `M`, `R old -> new`, then `ok: <n> files`), exit 1 lists each edit that failed
(`error: <code> <path>`, then `failed: <k> of <n> edits`) and changes nothing, exit 2 is a patch that could not be read.

---

<sub>Entered on [make.fun](https://make.fun/?ref=az2f4pjc&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

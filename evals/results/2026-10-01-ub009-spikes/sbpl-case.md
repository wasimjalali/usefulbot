# SBPL case-insensitivity spike (2026-10-01)

Question: does an SBPL path regex deny (agent/lib/sandbox.ts `plantedConfigRules`) also block a
differently-cased spelling of the same path, and does SBPL accept `(?i)`?

Host: macOS 26.6.2, APFS (`diskutil info /` shows "File System Personality: APFS"; the volume is
case-insensitive, confirmed by `ls .Claude/` listing a folder created as `.claude`).
Scratch folder: `<scratchpad>/sbpl-spike` (under /private/tmp). Each run:
`sandbox-exec -f <profile>.sb /bin/sh -c "echo hi > <path>"`.

## Profiles

All start with `(version 1)\n(allow default)\n` then one rule:

- plain (the shape sandbox.ts builds for `.claude/settings.json`, `regexEscape` + `($|[/.])`):
  `(deny file-write* (regex #"/\.claude/settings\.json($|[/.])"))`
- ci: `(deny file-write* (regex #"(?i)/\.claude/settings\.json($|[/.])"))`
- classes: `(deny file-write* (regex #"/\.[cC][lL][aA][uU][dD][eE]/[sS][eE][tT][tT][iI][nN][gG][sS]\.[jJ][sS][oO][nN]($|[/.])"))`

## Results

| profile | `.claude/settings.json` | `.Claude/Settings.json` | `.CLAUDE/SETTINGS.JSON` |
|---|---|---|---|
| plain | denied | denied | denied |
| ci `(?i)` | WRITTEN | WRITTEN | WRITTEN |
| classes | denied | denied | denied |

- Lowercase pattern vs a directory created on disk as `.Mixed`: `.mixed/cfg.json`, `.MIXED/cfg.json`,
  `.Mixed/CFG.JSON`, `.Mixed/cfg.json` all denied.
- Uppercase pattern `/\.MIXED/CFG\.JSON$` blocks a write to `.Mixed/cfg.json`; mixed-case pattern
  `/\.Mixed/cfg\.json$` blocks a write to `.mixed/cfg.json`. So on this volume the match is
  case-insensitive whichever case the pattern is written in.
- A directory created inside the sandbox under odd case (`mkdir .FRESH`) is still covered by a
  `/\.fresh/cfg\.json$` deny: the write to `.FRESH/cfg.json` was refused.

## Verdicts

1. A plain lowercase deny already blocks any casing of the path on this case-insensitive APFS volume,
   including the exact rule shape sandbox.ts generates.
2. `(?i)` is NOT a case-insensitive flag in SBPL. The profile loads without error but the rule matches
   nothing, so it silently denies nothing (all three writes succeeded). Never use it.
3. Letter classes `[cC][lL]...` work and are equivalent here. They only matter on a case-sensitive
   volume (an external or case-sensitive APFS volume), where the plain rule would miss a differently
   cased spelling but so would the OS, so the planted file would not be read as config either.
4. Caveat: the comment above the Application Support rule in agent/lib/sandbox.ts (~line 108) says
   "the kernel matches the path as the line spelled it", which this spike did not reproduce on this
   host: the kernel matched case-insensitively. Letter classes there are harmless belt and braces.
   Not tested: a case-sensitive volume.

## Review round 1 follow-up: parent create, rename, symlink, hard link (2026-10-01)

Question (PR #175 review, Sonnet): the per-file denies are leaf-name regexes, so can a planted file be put
under a planted parent name by creating the parent (mkdir, rename, symlink) or by a hard link?

Decision (owner): deny creating an entry whose last component is `.claude`, `.codex`, `.gemini`, `.cursor`
or `.github`, in the confined and the approved-line profiles, with
`(deny file-write-create (regex #"/\.claude$"))` and the same for the other four. Writing into an EXISTING
folder of that name stays governed by the per-file rules. The leaf list is
`PLANTED_CONFIG_CREATE_DENY_LEAVES` in `shared/policy.ts`.

Method: a script (`live.ts`, scratch copy only) builds `approvedLineProfile()` and
`sandboxProfile(<proj>, "folder")`, runs each line with
`/usr/bin/sandbox-exec -p <profile> /bin/sh -c 'cd <proj>; <line>'` in a fresh folder under the session
scratchpad (`<dir>/proj` is the project, `<dir>/home/.claude/settings.json` stands for a real config file).
Run on macOS 26.6.2, same host as above.

| line (in `proj`) | approved-line profile | confined (folder) profile |
|---|---|---|
| `mkdir .claude` | Operation not permitted | Operation not permitted |
| `mkdir stage; echo h > stage/settings.json; mv stage .claude` | mv refused | mv refused |
| `mkdir stage; echo h > stage/settings.json; ln -s stage .claude` | ln refused | ln refused |
| `mv stage .Claude` (case) | refused | refused |
| `mkdir .github`, `.cursor`, `.codex`, `.gemini` | all refused | all refused |
| `mkdir src` | ok | ok |

Hard link (the review's medium finding): `ln ../home/.claude/settings.json hl` then `echo evil >> hl`.
Result: `ln: hl: Operation not permitted` in both profiles, and the original file is unchanged. The existing
per-file deny already refuses the LINK, because the source path matches it (`file-link` is checked against
the source). `ln -s` to the same file creates a symlink at most, and a write through it is refused
(`sl: Operation not permitted`). So no extra link rule was needed; the unit test locks it in.

Cost claimed here: a bot can no longer `mkdir .github` (or the other four) itself. "`git init` and `git clone`
are not affected" was WRONG: a clone, `tar -x`, `unzip` or `cp -R` of a tree that contains `.github/` or
`.claude/` creates exactly those directories, and a first-time `codex login` or `gemini` sign-in makes
`~/.codex` or `~/.gemini`. Round 2 below replaces this broad deny.

## Round 2: narrower create denies (2026-10-01)

Round 2 review found the round-1 deny broke `git clone`, `tar -x`, `unzip`, `cp -R` of trees with `.github/` or
`.claude/`, and first-time CLI sign-ins. Owner decision, replacing it:

(a) deny creating a SYMLINK whose last component is `.claude`, `.codex`, `.gemini`, `.cursor` or `.github`,
anywhere, in both profiles:
`(deny file-write-create (require-all (vnode-type SYMLINK) (regex #"/\.claude$")))`.
Note: SBPL ORs the filters of one rule, so `(vnode-type SYMLINK) (regex ...)` without `require-all` denied EVERY
create (first attempt: `mkdir -p repo/.github/ISSUE_TEMPLATE` and `ln -s stage latest` were refused). `require-all`
is the fix.
(b) deny creating those five, plus `.config/git` and `.config/gh`, only directly under the owner's home
(`^<home>/\.claude$`), in the confined profile only. The approved-line profile may create them, so a first-time
login works; the planted files inside stay denied by the name rules.
(c) the command card (`agent/lib/command-risk.ts`) asks in Auto for `mv`, `cp -r/-R/-a`, `ln`, `rsync` and `ditto`
whose destination's last component is one of those names; Full access runs them.

Method: `live2.ts` (scratchpad copy), same harness as above, `HOME` pointed at a fake home inside the scratch
folder, a fresh project and home per line. Results (both profiles unless noted):

| line | approved-line profile | confined profile |
|---|---|---|
| `mkdir -p repo/.github/ISSUE_TEMPLATE` | ok | ok |
| `tar -xf t.tar` (tree with `.claude/notes.md`, `.github/ISSUE_TEMPLATE/bug.md`) | ok | ok |
| `cp -R src copy` (tree with `.claude/`) | ok | ok |
| `ln -s stage .claude`, `.Claude`, `.github`, `.cursor`, `.codex`, `.gemini` | refused | refused |
| `ln -s stage latest` | ok | ok |
| `mkdir <home>/.claude` | CREATED | refused |
| `mkdir <home>/.codex <home>/.config/gh <home>/.config/git` | CREATED | refused |
| write `<home>/.codex/config.toml` after creating the folder | refused | refused |
| `mkdir stage; mv stage .claude` inside the project | allowed by the kernel | allowed by the kernel |

Accepted residual: a script that renames a real directory to `.claude` inside a project is not caught by the
kernel (the last row). The command card catches a direct `mv`, `cp -r`, `ln`, `rsync` or `ditto` to those names.

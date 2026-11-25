# Lazy Reviewer

An AI-guided walk through a GitHub Pull Request. It follows the use cases in order of importance, opens a pane for each function the flow enters, and explains every span of code by quoting the real code.

It runs locally: it uses **your** GitHub login (`gh`) and **your** Claude account. There is no server in between.

## Requirements
- Node 20+
- GitHub CLI signed in: `gh auth login`
- One of these two ways to call Claude:
  - **Claude Code (default)**: the `claude` CLI, signed in (uses your claude.ai plan, no API key needed).
  - **API**: `LAZY_REVIEWER_PROVIDER=api` plus an `ANTHROPIC_API_KEY` with Console credit.

## Install (once)
```sh
git clone https://github.com/CampaUTN/lazy-reviewer.git
cd lazy-reviewer
npm install
npm link
```

## Use
```sh
lazy-reviewer https://github.com/<owner>/<repo>/pull/<n>
```
It opens `http://localhost:4321`.

Options: `--fresh` (regenerate even if cached) · `--port 5000` · `--no-open` · `--lang es`.

Environment variables:
| Variable | Default | What it does |
|---|---|---|
| `LAZY_REVIEWER_LANG` | your system locale | Language of the tour and the UI |
| `LAZY_REVIEWER_MODEL` | `claude-opus-5-5` | Claude model |
| `LAZY_REVIEWER_EFFORT` | `high` | Reasoning effort |
| `LAZY_REVIEWER_PROVIDER` | `claude-code` | `claude-code` or `api` |

## Language
Each user gets the tour in their own language: `--lang` wins, then `LAZY_REVIEWER_LANG`, then the system locale.
- The explanations can be in any language Claude writes (for example `--lang pt` or `--lang fr`).
- The UI and terminal messages are in English and Spanish; other languages fall back to English.
- Tours are cached per commit **and** language, so switching languages generates a new tour.

## Keys
| Key | Action |
|---|---|
| `→` / space | next step (enters core functions automatically) |
| `←` | previous step |
| `↓` | enter the function this step calls |
| `↑` / Esc | back to the calling function |
| `C` | show or hide the comments |
| `F` | show or hide the changed files panel |

The changed files panel on the right works like the VS Code explorer: click a file to open its functions in the tour (click again to cycle through them). Dimmed files are not covered by the tour; a ✓ means you read all of its steps.

## How it works
1. `gh` reads the PR and makes a `--bare` clone in `~/.lazy-reviewer/repos` (first time only).
2. It diffs against the merge base, reads the full changed files, and uses `git grep` to find the definitions of the functions the new code calls, even outside the PR.
3. Claude builds the tour: use cases in 4 layers (Critical → Support → Errors → Tests), and for each function a list of steps with their explanation.
4. Every explanation must quote, between backticks, a literal fragment of its lines. The ones that don't are sent back to be fixed once; if they still don't quote the code, the UI marks them with ⚠.
5. The result is cached in `~/.lazy-reviewer/tours` per commit and language: reopening the same PR spends no tokens.

## Current limits
- PRs up to ~225k tokens of context. Larger ones are rejected with a message.
- Deleted lines are not shown in the code; the explanation mentions them ("it used to…").

## License
MIT

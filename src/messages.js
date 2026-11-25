// Terminal and error messages.
const MESSAGES = {
  starting: "Starting…",
  claudeAccount: "Claude account: {0}",
  readingPr: "Reading PR {0}…",
  cached: "Tour cached for this commit (use --fresh to regenerate it).",
  ready: "Tour ready.",
  openAt: "lazy-reviewer open at {0}  (Ctrl+C to quit)",
  badUrl: "I don't recognize the PR link: {0}\nExpected format: https://github.com/<owner>/<repo>/pull/<number>",
  noGh: "No GitHub CLI session. Run `gh auth login` and try again.",
  cmdFailed: "{0} failed: {1}",
  cloning: "Cloning {0} (first time only)…",
  fetching: "Fetching the PR branches…",
  diffing: "Computing the diff…",
  readingFiles: "Reading {0} changed files…",
  findingDefs: "Looking up definitions of {0} called functions…",
  tooBig: "The PR is too large for a tour ({0}k characters, max {1}k).",
  claudeReading: "Claude is reading the PR (~{0}k tokens, via {1})…",
  claudeWriting: "Claude is writing the tour… {0} KB",
  claudeThinking: "Claude is building the tour… {0} (usually takes 2–5 min)",
  fixing: "Fixing {0} explanations that did not quote the code…",
  fixFailed: "Could not fix them: {0}",
  refusal: "Claude declined to generate a tour for this PR.",
  maxTokens: "The answer hit the max tokens: the PR is too large for a single tour.",
  notJson: "Claude Code did not return JSON (exit code {0}): {1}",
  ccFailed: "Claude Code failed: {0}",
  noCli: "Can't find the `claude` CLI. Install Claude Code and run `claude` once to sign in, or use LAZY_REVIEWER_PROVIDER=api with ANTHROPIC_API_KEY.",
  accApiKey: "API key …{0} (see the organization in Console → API keys)",
  accNoKey: "API without ANTHROPIC_API_KEY set",
  accNoSession: "Claude Code not signed in: run `claude` to sign in",
  accNoOrg: "no organization",
  accPlan: " · {0} plan",
  accReadFail: "Could not read the Claude Code session: {0}",
  accNoCli: "Can't find the `claude` CLI",
};

export function t(key, ...values) {
  return (MESSAGES[key] ?? key).replace(/\{(\d)\}/g, (_, i) => String(values[i] ?? ""));
}

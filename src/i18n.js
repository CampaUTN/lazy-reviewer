// Language: --lang <code> > LAZY_REVIEWER_LANG > the system locale. The UI supports
// English and Spanish; the tour itself is written in whatever language is picked.
const args = process.argv.slice(2);
const langArg = args.indexOf("--lang");
const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale || "en";

export const LANG = ((langArg >= 0 && args[langArg + 1]) || process.env.LAZY_REVIEWER_LANG || systemLocale)
  .toLowerCase().split(/[-_]/)[0];

export const LANGUAGE_NAME = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(LANG) || "English"; } catch { return "English"; }
})();

const DICT = {
  en: {
    usage: "Usage: lazy-reviewer <https://github.com/owner/repo/pull/123> [--fresh] [--port 4321] [--no-open] [--lang en]",
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
    noDescription: "(no description)",
  },
  es: {
    usage: "Uso: lazy-reviewer <https://github.com/owner/repo/pull/123> [--fresh] [--port 4321] [--no-open] [--lang es]",
    starting: "Iniciando…",
    claudeAccount: "Cuenta de Claude: {0}",
    readingPr: "Leyendo el PR {0}…",
    cached: "Recorrido en caché para este commit (usa --fresh para regenerarlo).",
    ready: "Recorrido listo.",
    openAt: "lazy-reviewer abierto en {0}  (Ctrl+C para salir)",
    badUrl: "No reconozco el link del PR: {0}\nFormato esperado: https://github.com/<owner>/<repo>/pull/<número>",
    noGh: "No hay sesión de GitHub CLI. Corre `gh auth login` y vuelve a intentar.",
    cmdFailed: "{0} falló: {1}",
    cloning: "Clonando {0} (solo la primera vez)…",
    fetching: "Trayendo las ramas del PR…",
    diffing: "Calculando el diff…",
    readingFiles: "Leyendo {0} archivos modificados…",
    findingDefs: "Buscando definiciones de {0} funciones llamadas…",
    tooBig: "El PR es demasiado grande para un recorrido ({0}k caracteres, máximo {1}k).",
    claudeReading: "Claude está leyendo el PR ({0}k tokens aprox., vía {1})…",
    claudeWriting: "Claude está escribiendo el recorrido… {0} KB",
    claudeThinking: "Claude está armando el recorrido… {0} (suele tardar 2–5 min)",
    fixing: "Corrigiendo {0} explicaciones que no citaban el código…",
    fixFailed: "No se pudieron corregir: {0}",
    refusal: "Claude rechazó generar el recorrido para este PR.",
    maxTokens: "La respuesta superó el máximo de tokens: el PR es demasiado grande para un solo recorrido.",
    notJson: "Claude Code no devolvió JSON (código {0}): {1}",
    ccFailed: "Claude Code falló: {0}",
    noCli: "No encuentro el CLI `claude`. Instala Claude Code y corre `claude` una vez para iniciar sesión, o usa LAZY_REVIEWER_PROVIDER=api con ANTHROPIC_API_KEY.",
    accApiKey: "API key …{0} (la organización se ve en Console → API keys)",
    accNoKey: "API sin ANTHROPIC_API_KEY definida",
    accNoSession: "Claude Code sin sesión: corre `claude` para iniciar sesión",
    accNoOrg: "sin organización",
    accPlan: " · plan {0}",
    accReadFail: "No se pudo leer la sesión de Claude Code: {0}",
    accNoCli: "No encuentro el CLI `claude`",
    noDescription: "(sin descripción)",
  },
};

const strings = DICT[LANG] ?? DICT.en;

export function t(key, ...values) {
  return (strings[key] ?? DICT.en[key] ?? key).replace(/\{(\d)\}/g, (_, i) => String(values[i] ?? ""));
}

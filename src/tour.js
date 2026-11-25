// Builds the PR "tour" with Claude and checks that every explanation is anchored to the code.
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LANGUAGE_NAME, t } from "./i18n.js";

const MODEL = process.env.LAZY_REVIEWER_MODEL || "claude-opus-5-5";
const EFFORT = process.env.LAZY_REVIEWER_EFFORT || "high";

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const STEP = obj({
  startLine: int,
  endLine: int,
  explanation: str,
  enters: str,          // id of the frame this step enters, or "" if none
  autoEnter: { type: "boolean" },
});
const FRAME = obj({
  id: str,
  name: str,
  file: str,
  startLine: int,
  endLine: int,
  role: { type: "string", enum: ["core", "helper", "trivial"] },
  summary: str,
  steps: { type: "array", items: STEP },
});
const USE_CASE = obj({ id: str, title: str, trigger: str, rootFrame: str, outro: str });
const SECTION = obj({
  layer: { type: "string", enum: ["critical", "support", "errors", "tests"] },
  useCases: { type: "array", items: USE_CASE },
});
const TOUR_SCHEMA = obj({
  title: str,
  summary: str,
  frames: { type: "array", items: FRAME },
  sections: { type: "array", items: SECTION },
});
const REPAIR_SCHEMA = obj({
  fixes: { type: "array", items: obj({ frameId: str, stepIndex: int, explanation: str }) },
});

const SYSTEM = `You are a senior code reviewer guiding another developer through a Pull Request.
Your output is a "tour": an ordered walk through the code, the way a professional would do it. It is shown in a UI with the code highlighted and stacked panes (one per function the reader enters).

LANGUAGE
- Write every human-readable text (title, summary, frame summaries, explanations, use case titles, triggers and outros) in ${LANGUAGE_NAME}. Code, identifiers and quoted fragments stay exactly as in the source.

WHAT YOU PRODUCE
- frames: one entry per relevant function/method (from the PR or from the external definitions provided). Each frame has steps: spans of 1 to 10 lines that do ONE thing, in execution order.
- sections: the use cases grouped by layer, in this layer order:
  1. "critical": the business logic the PR adds or changes. One use case per real flow (e.g. "Place an order", "Cancel a shipment"). rootFrame = the entry point (endpoint, handler, job, command, component).
  2. "support": helpers, utilities, mappers, refactors that do not change behavior.
  3. "errors": error handling, technical validations, guards, retries, logging.
  4. "tests": tests, fixtures, configuration, trivial migrations, types.
  Skip empty layers. Inside each layer, sort by importance.

HOW THE TOUR IS WALKED
- A step with "enters" = the id of another frame means that line calls that function. autoEnter=true if the function is a central part of the flow (the reader enters it automatically and a new pane opens); autoEnter=false for helpers and trivial functions (the reader may enter optionally).
- Do not create frames for trivial one-line functions unless their logic matters; in that case explain what they return in the step that calls them.
- Frames with role "core" belong to the critical flow; "helper" to support; "trivial" have almost no logic.
- Cover ALL added or modified lines (marked with "+") in some step of some frame. You may skip unchanged boilerplate.
- Line numbers are the ones in the listing (new version of the file). The frame's startLine/endLine cover the whole function; steps must fall inside that range.

EXPLANATION RULES (the most important ones)
- 1 to 3 sentences, direct.
- Each explanation MUST quote between backticks at least one fragment copied literally from its lines (e.g. \`cart.items.length === 0\`).
- Explain the CONCRETE meaning in this code, never the generic semantics of the language.
  BAD: "Uses find to search for an element in the list."
  GOOD: "Picks the first coupon with \`c.expiresAt > now\` for the current \`cartId\`: it is the discount applied at checkout."
  BAD: "Validates the input."  GOOD: "Rejects the request if \`items.length === 0\` or any \`qty <= 0\`."
- Say which condition, which values, and what effect it has on the use case. If a line changed from the previous version (see the ORIGINAL DIFF), say what it did before and why the change matters.
- If you see a possible bug or risk in that span, add it at the end with the prefix "⚠ ".
- title: short PR title in business language. summary: 3-5 sentences on what the PR changes and why.
- Use case trigger: what fires it (e.g. "POST /orders from checkout"). outro: 1-2 sentences with the final result of the flow.`;

// ---------- validation ----------
const norm = (s) => s.replace(/\s+/g, " ").trim();

function codeSpans(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => norm(m[1])).filter((s) => s.length >= 2);
}

export function validateTour(tour, fileViews) {
  const problems = [];
  const frameIds = new Set(tour.frames.map((f) => f.id));
  for (const frame of tour.frames) {
    const view = fileViews[frame.file];
    if (!view) { problems.push({ frame, kind: "file", msg: `unknown file ${frame.file}` }); continue; }
    const max = view.lines.length;
    frame.startLine = Math.max(1, Math.min(frame.startLine, max));
    frame.endLine = Math.max(frame.startLine, Math.min(frame.endLine, max));
    frame.steps.forEach((step, i) => {
      step.startLine = Math.max(1, Math.min(step.startLine, max));
      step.endLine = Math.max(step.startLine, Math.min(step.endLine, max));
      // if a step falls outside its frame, widen the frame (showing more beats showing less)
      frame.startLine = Math.min(frame.startLine, step.startLine);
      frame.endLine = Math.max(frame.endLine, step.endLine);
      if (step.enters && !frameIds.has(step.enters)) step.enters = "";
      const code = norm(view.lines.slice(step.startLine - 1, step.endLine).join("\n"));
      const spans = codeSpans(step.explanation);
      step.anchored = spans.some((s) => code.includes(s));
      if (!step.anchored) problems.push({ frame, stepIndex: i, step, code: view.lines.slice(step.startLine - 1, step.endLine).join("\n") });
    });
  }
  for (const s of tour.sections) s.useCases = s.useCases.filter((u) => frameIds.has(u.rootFrame));
  tour.sections = tour.sections.filter((s) => s.useCases.length);
  const order = ["critical", "support", "errors", "tests"];
  tour.sections.sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer));
  return problems.filter((p) => p.step);
}

// ---------- calling Claude ----------
// Two ways to call Claude, both with the user's own account:
//  - "claude-code" (default): the `claude -p` CLI with the Claude Code login (claude.ai plan).
//  - "api": the API with ANTHROPIC_API_KEY (prepaid Console credit).
export const PROVIDER = process.env.LAZY_REVIEWER_PROVIDER || "claude-code";

function claudeBinaries() {
  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return ["claude", local];
}

function runClaudeCode(bin, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

// Which Claude account will be used (shown in the terminal and the UI).
export async function getAccount() {
  if (PROVIDER === "api") {
    const key = process.env.ANTHROPIC_API_KEY;
    return { provider: "api", label: key ? t("accApiKey", key.slice(-4)) : t("accNoKey") };
  }
  for (const bin of claudeBinaries()) {
    try {
      const { out } = await runClaudeCode(bin, ["auth", "status"], "");
      const s = JSON.parse(out);
      if (!s.loggedIn) return { provider: "claude-code", label: t("accNoSession") };
      const plan = s.subscriptionType ? t("accPlan", s.subscriptionType) : "";
      return { provider: "claude-code", email: s.email, org: s.orgName, plan: s.subscriptionType, label: `${s.email ?? "?"} · ${s.orgName ?? t("accNoOrg")}${plan}` };
    } catch (e) {
      if (e.code === "ENOENT") continue;
      return { provider: "claude-code", label: t("accReadFail", e.message) };
    }
  }
  return { provider: "claude-code", label: t("accNoCli") };
}

async function askClaudeCode({ system, user, schema, onProgress }) {
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
    "--system-prompt", system, "--model", MODEL, "--effort", EFFORT];
  const started = Date.now();
  const timer = setInterval(() => onProgress?.(Math.round((Date.now() - started) / 1000)), 1000);
  try {
    for (const bin of claudeBinaries()) {
      let res;
      try { res = await runClaudeCode(bin, args, user); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      let json;
      try { json = JSON.parse(res.out); } catch { throw new Error(t("notJson", res.code, (res.err || res.out).slice(0, 500))); }
      if (json.is_error || !json.structured_output) {
        throw new Error(t("ccFailed", json.result || json.subtype || res.err).slice(0, 800));
      }
      return { data: json.structured_output, usage: json.usage, costUsd: json.total_cost_usd };
    }
    throw new Error(t("noCli"));
  } finally {
    clearInterval(timer);
  }
}

async function ask(client, opts) {
  if (PROVIDER === "claude-code") return askClaudeCode({ ...opts, onProgress: opts.onSeconds });
  return askApi(client, opts);
}

async function askApi(client, { system, user, schema, maxTokens, onProgress }) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
  });
  let chars = 0;
  stream.on("text", (delta) => { chars += delta.length; onProgress?.(chars); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error(t("refusal"));
  if (msg.stop_reason === "max_tokens") throw new Error(t("maxTokens"));
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { data: JSON.parse(text), usage: msg.usage };
}

export async function generateTour({ meta, context }, log) {
  const client = PROVIDER === "api" ? new Anthropic() : null;
  const user = `PR #${meta.number}: ${meta.title}
Author: ${meta.author?.login ?? "?"}   ${meta.headRefName} → ${meta.baseRefName}
Author's description:
${(meta.body || "(no description)").slice(0, 4000)}

Listing format: "  line [+]| code". "+" = line added or modified by the PR.
${context.prompt}`;

  log(t("claudeReading", Math.round(context.stats.chars / 4000), PROVIDER));
  const { data: tour, usage, costUsd } = await ask(client, {
    system: SYSTEM, user, schema: TOUR_SCHEMA, maxTokens: 64000,
    onProgress: (c) => log(t("claudeWriting", Math.round(c / 1000))),
    onSeconds: (s) => log(t("claudeThinking", `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`)),
  });

  let problems = validateTour(tour, context.fileViews);
  if (problems.length) {
    log(t("fixing", problems.length));
    const list = problems.map((p) => `### frameId=${p.frame.id} stepIndex=${p.stepIndex} (${p.frame.file}:${p.step.startLine}-${p.step.endLine})
Code:
${p.code}
Current explanation: ${p.step.explanation}`).join("\n\n");
    try {
      const { data } = await ask(client, {
        system: SYSTEM,
        user: `These explanations do not quote between backticks a literal fragment of their code, or they are generic. Rewrite them following the rules (fragment copied EXACTLY from the code, concrete meaning, in ${LANGUAGE_NAME}).\n\n${list}`,
        schema: REPAIR_SCHEMA, maxTokens: 32000,
      });
      for (const fix of data.fixes) {
        const step = tour.frames.find((f) => f.id === fix.frameId)?.steps[fix.stepIndex];
        if (step) step.explanation = fix.explanation;
      }
      problems = validateTour(tour, context.fileViews);
    } catch (err) {
      log(t("fixFailed", err.message));
    }
  }
  tour.model = `${MODEL} (${PROVIDER})`;
  tour.usage = usage;
  tour.costUsd = costUsd;
  tour.account = await getAccount();
  tour.unanchored = problems.length;
  return tour;
}

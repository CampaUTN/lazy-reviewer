// GitHub access through the user's own `gh` CLI login and a local clone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { t } from "./i18n.js";

const run = promisify(execFile);
export const HOME_DIR = join(homedir(), ".lazy-reviewer");

async function sh(cmd, args, opts = {}) {
  try {
    const { stdout } = await run(cmd, args, { maxBuffer: 512 * 1024 * 1024, ...opts });
    return stdout;
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().trim();
    throw new Error(t("cmdFailed", `${cmd} ${args.slice(0, 3).join(" ")}`, detail));
  }
}

export const git = (repoDir, args) => sh("git", ["-C", repoDir, ...args]);

export function parsePrUrl(input) {
  const m = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(t("badUrl", input));
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export async function checkGh() {
  try {
    await sh("gh", ["auth", "status"]);
  } catch {
    throw new Error(t("noGh"));
  }
}

export async function fetchPrMeta({ owner, repo, number }) {
  const out = await sh("gh", [
    "pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json",
    "number,title,body,url,author,headRefName,baseRefName,headRefOid,baseRefOid,additions,deletions,changedFiles",
  ]);
  return JSON.parse(out);
}

// Cached bare clone per repo: no checkout, everything is read with `git show` / `git grep`.
export async function prepareRepo({ owner, repo, number }, meta, log) {
  const reposDir = join(HOME_DIR, "repos");
  mkdirSync(reposDir, { recursive: true });
  const dir = join(reposDir, `${owner}__${repo}.git`);
  if (!existsSync(dir)) {
    log(t("cloning", `${owner}/${repo}`));
    await sh("gh", ["repo", "clone", `${owner}/${repo}`, dir, "--", "--bare", "--quiet"]);
  }
  log(t("fetching"));
  const headRef = `refs/prtour/pr-${number}-head`;
  const baseRef = `refs/prtour/pr-${number}-base`;
  await git(dir, ["fetch", "--quiet", "origin",
    `+refs/pull/${number}/head:${headRef}`,
    `+refs/heads/${meta.baseRefName}:${baseRef}`]);
  const mergeBase = (await git(dir, ["merge-base", baseRef, headRef])).trim();
  const head = (await git(dir, ["rev-parse", headRef])).trim();
  return { dir, head, mergeBase };
}

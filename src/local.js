// Local sources: review code that is not (or not yet) a PR.
//  - staged:  what `git add` put in the index, compared to HEAD.
//  - branch:  the current branch (HEAD) compared to a base branch. The base is, in order:
//             --base <branch>, the base of the branch's open PR (via gh), or origin's default branch.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git } from "./github.js";
import { t } from "./messages.js";

const run = promisify(execFile);
const tryGit = async (dir, args) => { try { return (await git(dir, args)).trim(); } catch { return null; } };

async function repoRoot(path) {
  const root = await tryGit(path, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error(t("notRepo", path));
  return root;
}

// Base of the open PR for the current branch, if gh knows one.
async function prBase(dir) {
  try {
    const { stdout } = await run("gh", ["pr", "view", "--json", "baseRefName,number,url"], { cwd: dir });
    return JSON.parse(stdout);
  } catch { return null; }
}

async function defaultBranch(dir) {
  const ref = await tryGit(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (ref) return ref.replace("refs/remotes/origin/", "");
  for (const b of ["main", "master", "develop"]) if (await tryGit(dir, ["rev-parse", "--verify", "--quiet", b])) return b;
  return null;
}

// Prefer origin/<base> (fetched just now) over a possibly stale local branch.
async function resolveBase(dir, base, log) {
  if (await tryGit(dir, ["remote", "get-url", "origin"])) {
    log(t("fetchingBase", base));
    await tryGit(dir, ["fetch", "--quiet", "origin", base]);
    if (await tryGit(dir, ["rev-parse", "--verify", "--quiet", `origin/${base}`])) return `origin/${base}`;
  }
  if (await tryGit(dir, ["rev-parse", "--verify", "--quiet", base])) return base;
  throw new Error(t("noBase", base));
}

export async function prepareLocal({ mode, path = process.cwd(), base }, log) {
  const dir = await repoRoot(path);
  const name = basename(dir);
  const author = (await tryGit(dir, ["config", "user.name"])) ?? "?";
  const branch = (await tryGit(dir, ["branch", "--show-current"])) || "HEAD";

  if (mode === "staged") {
    const diff = await git(dir, ["diff", "--cached", "--no-color"]);
    if (!diff.trim()) throw new Error(t("nothingStaged"));
    const hash = createHash("sha1").update(diff).digest("hex").slice(0, 12);
    return {
      repo: { dir, staged: true },
      key: `local__${name}__staged__${hash}`,
      meta: { title: t("stagedTitle", branch), body: "", author: { login: author }, headRefName: t("stagedRef"), baseRefName: branch },
      pr: { local: true, mode, repo: name, title: t("stagedTitle", branch), author, head: t("stagedRef"), base: branch },
    };
  }

  let pr = null;
  if (!base) {
    pr = await prBase(dir);
    base = pr?.baseRefName ?? (await defaultBranch(dir));
    if (!base) throw new Error(t("noDefaultBase"));
    log(pr ? t("baseFromPr", base, pr.number) : t("baseDefault", base));
  }
  const baseRef = await resolveBase(dir, base, log);
  const head = await git(dir, ["rev-parse", "HEAD"]).then((s) => s.trim());
  const mergeBase = await tryGit(dir, ["merge-base", baseRef, head]);
  if (!mergeBase) throw new Error(t("noMergeBase", baseRef));
  // The branch's commits plus whatever is staged on top: the "new" side is the index.
  const staged = await git(dir, ["diff", "--cached", "--no-color"]);
  const hasCommits = mergeBase !== head;
  if (!hasCommits && !staged.trim()) throw new Error(t("nothingOnBranch", branch, base));
  if (staged.trim()) log(t(hasCommits ? "branchPlusStaged" : "onlyStaged", base));
  const stagedHash = staged.trim() ? createHash("sha1").update(staged).digest("hex").slice(0, 12) : "none";
  // The commit messages work as the "description" of the change.
  const commits = hasCommits ? (await tryGit(dir, ["log", "--format=- %s%n%b", `${mergeBase}..${head}`])) ?? "" : "";
  const title = t(staged.trim() ? "branchStagedTitle" : "branchTitle", branch, base);
  return {
    repo: { dir, staged: true, mergeBase },
    key: `local__${name}__branch__${head.slice(0, 12)}__${mergeBase.slice(0, 12)}__${stagedHash}`,
    meta: { title, body: commits, bodyLabel: "Commit messages on this branch (plus any staged changes)", author: { login: author }, headRefName: branch, baseRefName: base },
    pr: { local: true, mode, repo: name, title, author, head: branch, base, url: pr?.url ?? null, number: pr?.number ?? null },
  };
}

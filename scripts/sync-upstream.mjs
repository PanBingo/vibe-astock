#!/usr/bin/env node
/**
 * 手动把上游 merge 到一条新的 sync 分支，并可选择只创建 PR。
 * 不重置、不强推、不合并 PR、不被定时任务调用。
 *
 *   node scripts/sync-upstream.mjs --dry-run
 *   node scripts/sync-upstream.mjs --pr
 *
 * origin 必须是当前 fork。upstream 若还没有，用 GitHub API 读 origin 的 parent，不猜地址。
 */
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
if ([...args].some((a) => a === "--force" || a === "-f" || a.includes("reset") || a.includes("force"))) {
  console.error("这个脚本不接受 force / reset。");
  process.exit(2);
}
const dry = args.has("--dry-run");
const openPr = args.has("--pr");
if ([...args].some((a) => !["--dry-run", "--pr"].includes(a))) {
  console.error("只接受 --dry-run 和 --pr。");
  process.exit(2);
}

function git(cmd, extra = []) {
  return execFileSync("git", [cmd, ...extra], { encoding: "utf8" }).trim();
}
function run(cmd, extra) {
  const r = spawnSync(cmd, extra, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const status = git("status", ["--porcelain"]);
if (status && !dry) {
  console.error("工作区不干净，先处理完再同步。");
  process.exit(2);
}

function originSlug() {
  const url = git("remote", ["get-url", "origin"]);
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  if (!m) {
    console.error(`认不出 origin：${url}`);
    process.exit(2);
  }
  return `${m[1]}/${m[2]}`;
}

function ghJson(path) {
  const r = spawnSync("gh", ["api", path], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || `gh api ${path} 失败`);
    process.exit(r.status ?? 1);
  }
  return JSON.parse(r.stdout);
}

const origin = originSlug();
const meta = ghJson(`repos/${origin}`);
const parent = meta.parent?.full_name || meta.source?.full_name;
if (!parent || !meta.fork) {
  console.error(`${origin} 的 GitHub 元数据里没有 parent/source，不能确定上游。`);
  process.exit(2);
}
const upstreamMeta = ghJson(`repos/${parent}`);
const upstreamBranch = upstreamMeta.default_branch;
const upstreamUrl = upstreamMeta.clone_url;
if (!upstreamBranch || !upstreamUrl) {
  console.error("上游默认分支或 clone 地址缺失。");
  process.exit(2);
}

let hasUpstream = true;
try { git("remote", ["get-url", "upstream"]); } catch { hasUpstream = false; }
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
const branch = `sync/upstream-${stamp}`;

console.log(`origin=${origin}  upstream=${parent}  默认分支=${upstreamBranch}`);
console.log(`将从 origin/main 建 ${branch}，再 merge upstream/${upstreamBranch}。`);
console.log("不会 reset，不会强推，不会合并 PR。");
if (dry) {
  console.log(hasUpstream ? "upstream 远程已存在。" : `将执行 git remote add upstream ${upstreamUrl}`);
  process.exit(0);
}

if (!hasUpstream) run("git", ["remote", "add", "upstream", upstreamUrl]);
run("git", ["fetch", "origin", "main"]);
run("git", ["fetch", "upstream", upstreamBranch]);
run("git", ["checkout", "-b", branch, "origin/main"]);
const merged = spawnSync("git", ["merge", "--no-edit", `upstream/${upstreamBranch}`], { stdio: "inherit" });
if (merged.status !== 0) {
  console.error("合并有冲突或失败。分支留在合并中，请逐项解决后自己推送并开 PR。脚本不会强推，也不会代为合并。");
  process.exit(merged.status ?? 1);
}
console.log("合并完成。请运行 orchestrator 与 desktop 的测试、类型检查和构建，再推送。");
if (!openPr) {
  console.log(`需要 PR 时再运行：git push -u origin ${branch}，然后 gh pr create --repo ${origin} --base main --head ${branch}`);
  process.exit(0);
}
run("git", ["push", "-u", "origin", branch]);
run("gh", ["pr", "create", "--repo", origin, "--base", "main", "--head", branch, "--title", `sync upstream ${upstreamBranch}`, "--body", `把 ${parent} 的 \`${upstreamBranch}\` merge 进本 fork。请先看冲突是否还在、测试是否通过。此 PR 不自动合并。`]);

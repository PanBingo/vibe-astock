// 同步辅助必须保持手动、只建 PR。这里查脚本正文，防止以后改出 reset / 强推 / 定时合并。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const script = fs.readFileSync(path.join(process.cwd(), "../scripts/sync-upstream.mjs"), "utf8");
const doc = fs.readFileSync(path.join(process.cwd(), "../docs/fork-sync.md"), "utf8");

test("同步脚本拒绝 force/reset，并且不会自己合并 PR", () => {
  assert.match(script, /不接受 force \/ reset/);
  assert.match(script, /--dry-run/);
  assert.match(script, /parent/);
  assert.doesNotMatch(script, /reset\s+--hard/);
  assert.doesNotMatch(script, /push\s+--force|push\s+-f\b/);
  assert.doesNotMatch(script, /pr\s+merge|merge\s+--auto/);
  assert.doesNotMatch(script, /cron|schedule/);
  assert.match(doc, /simonlin1212\/vibe-astock/);
  assert.match(doc, /不要 `git reset --hard upstream\/main`/);
  assert.match(doc, /不保证以后的上游提交都能自动合上|冲突可以反复出现/);
});

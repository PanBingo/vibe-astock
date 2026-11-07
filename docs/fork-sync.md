# Fork 与上游同步

2026-11-07 用 GitHub API 核对过，不是凭仓库简介猜的：

- `GET /repos/PanBingo/vibe-astock` 的 `parent` 和 `source` 都是 `simonlin1212/vibe-astock`，`fork` 为 true。
- `GET /repos/simonlin1212/vibe-astock` 的 `default_branch` 是 `main`，clone 地址是 `https://github.com/simonlin1212/vibe-astock.git`。

## 远程怎么放

| 远程 | 仓库 | 用途 |
|---|---|---|
| `origin` | `https://github.com/PanBingo/vibe-astock.git` | 这个 fork。功能分支从这里长出来，PR 回到 fork 的 `main` |
| `upstream` | `https://github.com/simonlin1212/vibe-astock.git` | 原作者。只用来 fetch 和 merge，不把 fork 的功能直接推上去 |

产品名和界面上的仓库链接写在 `orchestrator/src/brand.ts` 与 `desktop/src/verticals/finance/lib/brand.ts`，值仍是上游 `simonlin1212/vibe-astock`。同步时保留这两份，不要改成 PanBingo。

实时洞察放在 `orchestrator/src/finance/live_insight/`，页面是盯盘下的独立路由。合并上游时优先保留这个目录，以及 `register_tasks.ts` 里的一行导入、`schedule.ts` 里把采集挂进原有拍子的那段、导航和 `/watch/insight` 路由。

## 安全同步（不覆盖自己的提交）

在干净的工作区里做。下面的 `main` 都是 **fork 的 main**。

```bash
git remote add upstream https://github.com/simonlin1212/vibe-astock.git   # 还没有这个远程时
git fetch origin main
git fetch upstream main
git checkout -b sync/upstream-YYYYMMDD origin/main
git merge upstream/main
```

冲突逐项看：品牌文件、短线复盘和本 fork 的 `live_insight` 不要整段退回上游。解完再跑：

```bash
npm test --prefix orchestrator
npm run typecheck --prefix orchestrator
npm test --prefix desktop
npm run build --prefix desktop
```

然后把 `sync/upstream-*` 推到 `origin`，开 PR，**base 是 fork 的 `main`**。PR 只是给自己审，不要在脚本或定时任务里合并。

不要做的事：

- 不要 `git reset --hard upstream/main`，那会丢掉 fork 上的提交。
- 不要 `git push --force` 到 `main`。
- 不要把 upstream 直接 merge 进正在用的 `main` 工作区还不经过 PR。
- 冲突可以反复出现。文档不保证以后的上游提交都能自动合上。

## 手动辅助

`scripts/sync-upstream.mjs` 只在你自己运行时做事，仓库里没有 cron，也没有会自动合并的 GitHub Action。

```bash
node scripts/sync-upstream.mjs --dry-run
node scripts/sync-upstream.mjs --pr
```

`--pr` 会从 `origin/main` 建新的 `sync/upstream-*` 分支、merge `upstream` 的默认分支、推上去，并用 `gh pr create` 打开 PR。有冲突就停在合并中，不推、不建 PR。脚本拒绝 `--force` 和 `reset --hard`。它不合并 PR，也不改 `main`。

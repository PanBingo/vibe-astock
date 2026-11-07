/** 观察池只追加、重连启动日，不删除历史。页面读取不经过这里的写入。 */
import { readJsonIfExists, writeJson } from "../../fsutil.ts";
import { safePath, type ServiceContext } from "../../service.ts";
import { linkLaunches } from "./analyze.ts";
import { POOL_SCHEMA, type AnchorEntry, type EnrollRun, type PoolFile, type PoolStock, type QuoteCache } from "./types.ts";

const chains = new Map<string, Promise<unknown>>();

export function poolFile(ctx: Pick<ServiceContext, "dataRoot">): string {
  return safePath(ctx, "limit-watch", "pool.json");
}

export function emptyPool(): PoolFile {
  return { schema: POOL_SCHEMA, entries: [], quotes: [], runs: [] };
}

export function readPool(ctx: Pick<ServiceContext, "dataRoot">): PoolFile {
  const row = readJsonIfExists<PoolFile>(poolFile(ctx));
  if (!row || row.schema !== POOL_SCHEMA || !Array.isArray(row.entries)) return emptyPool();
  return { schema: POOL_SCHEMA, entries: row.entries, quotes: Array.isArray(row.quotes) ? row.quotes : [], runs: Array.isArray(row.runs) ? row.runs : [] };
}

function writePool(ctx: Pick<ServiceContext, "dataRoot">, pool: PoolFile): void {
  writeJson(poolFile(ctx), pool);
}

export function updatePool<T>(ctx: Pick<ServiceContext, "dataRoot">, fn: (pool: PoolFile) => T): Promise<T> {
  const key = poolFile(ctx);
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(() => {
    const pool = readPool(ctx);
    const result = fn(pool);
    writePool(ctx, pool);
    return result;
  });
  chains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

export function resetPoolChain(): void { chains.clear(); }

/** 同一交易日同一只只保留一条。新字段补进旧记录，不改第一次入池时间，也不删别的日子。 */
export function mergeEntries(existing: AnchorEntry[], date: string, stocks: PoolStock[], qdate: string, at: string): { entries: AnchorEntry[]; added: number } {
  const have = new Set(existing.filter((e) => e.trade_date === date).map((e) => e.symbol));
  const fresh: AnchorEntry[] = [];
  for (const s of stocks) {
    if (have.has(s.symbol)) continue;
    have.add(s.symbol);
    fresh.push({
      symbol: s.symbol, name: s.name, industry: s.industry, trade_date: date, boards: s.boards, first_seal: s.first_seal,
      source: "em_zt_pool", pool_qdate: qdate, enrolled_at: at, role: "launch", launch_date: null,
    });
  }
  return { entries: linkLaunches([...existing, ...fresh]), added: fresh.length };
}

export function rememberRun(pool: PoolFile, run: EnrollRun): void {
  pool.runs = [...pool.runs.filter((r) => !(r.date === run.date && r.at === run.at)), run].slice(-200);
}

export function rememberQuote(pool: PoolFile, quote: QuoteCache): void {
  pool.quotes = [...pool.quotes.filter((q) => q.symbol !== quote.symbol), quote];
}

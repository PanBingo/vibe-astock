/**
 * 盯盘 · 实时洞察。数字来自本机按间隔存下的公开行情与资金快照，不是复盘端点，也不是买卖建议。
 * 疑似建仓只是东财主力净额累计形态的统计推断。
 */
import { Activity, Layers, Radio, Waves } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiPage } from "../../../core/ai/pageContext";
import { Section } from "./FactsPanels";
import { finite, pctColor, rate, signed, yi } from "./format";
import { GapsAndSource } from "./ViewBits";
import type { InsightAccumulation, InsightAnomaly, InsightBoard, InsightDiffusion, InsightHotspot, LiveInsightView, Reliability } from "./insightTypes";
import { useLiveInsight } from "./useLiveInsight";

const REL: Record<Reliability, string> = { high: "高", medium: "中", low: "低" };
const OUTCOME: Record<string, string> = { saved: "已存", throttled: "未到间隔", skipped: "没有采集", failed: "没采成", disabled: "已关闭" };
const money = (v: number | null | undefined) => {
  const n = finite(v);
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${yi(n)}`;
};

function Rel({ v }: { v: Reliability | null }) {
  if (!v) return null;
  return <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">可靠性 {REL[v]}</span>;
}

function BoardTable({ rows, label }: { rows: InsightBoard[]; label: string }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">这一侧还没有板块快照。</p>;
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full text-left text-[12px]">
        <thead className="text-[11px] text-muted-foreground">
          <tr>
            {["板块", "净额", "较对照", "涨跌", "涨/跌家数", "序列"].map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-t border-border/40">
              <td className="px-2 py-1"><b>{r.name}</b> <span className="font-mono text-[11px] text-muted-foreground">{r.code}</span>{r.leader ? <span className="text-muted-foreground"> · 领涨 {r.leader}</span> : null}</td>
              <td className={cn("px-2 py-1 font-mono tabular-nums", pctColor(r.main_net))}>{money(r.main_net)}</td>
              <td className={cn("px-2 py-1 font-mono tabular-nums", pctColor(r.delta_net))}>{r.delta_net == null ? "—" : money(r.delta_net)}{r.baseline_clock ? <span className="ml-1 text-[10px] text-muted-foreground">自 {r.baseline_clock}</span> : null}</td>
              <td className={cn("px-2 py-1 font-mono tabular-nums", pctColor(r.change_pct))}>{signed(r.change_pct)}</td>
              <td className="px-2 py-1 font-mono text-muted-foreground">{r.up_count == null && r.down_count == null ? "—" : `${r.up_count ?? "—"}/${r.down_count ?? "—"}`}</td>
              <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">{r.history.map((h) => `${h.clock} ${money(h.main_net)}`).join(" → ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Anomalies({ rows, note }: { rows: InsightAnomaly[]; note: string | null }) {
  if (!rows.length) return <p role="status" className="text-[13px] text-muted-foreground">{note ?? "当前窗口里没有越过阈值的板块资金变化。"}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((a) => (
        <li key={`${a.kind}-${a.code}`} className="rounded-lg border border-border/60 px-3 py-2 text-[13px]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <b>{a.kind === "industry" ? "行业" : "概念"} {a.name}</b>
            <Rel v={a.reliability} />
            <span className="text-[11px] text-muted-foreground">{a.baseline_clock} → {a.latest_clock}</span>
          </div>
          <p>{a.explanation}</p>
        </li>
      ))}
    </ul>
  );
}

function Flows({ rows }: { rows: InsightAccumulation[] }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">这次没有个股分钟资金样本。</p>;
  return (
    <ul className="space-y-2">
      {rows.map((a) => (
        <li key={a.code} className="rounded-lg border border-border/60 px-3 py-2 text-[13px]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <b>{a.name}</b> <span className="font-mono text-[11px] text-muted-foreground">{a.code}</span>
            <span className="text-[11px] text-muted-foreground">{a.status === "suspected" ? "疑似低波动净流入" : a.status === "insufficient" ? "样本不足" : a.status === "stale" ? "数据陈旧" : a.status === "lunch" ? "午休" : "未形成该形态"}</span>
            <Rel v={a.reliability} />
          </div>
          <p>{a.statement}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{a.disclaimer}</p>
        </li>
      ))}
    </ul>
  );
}

function Hotspots({ rows }: { rows: InsightHotspot[] }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">没有可展示的涨停行业结构。</p>;
  return (
    <ul className="grid gap-2 md:grid-cols-2">
      {rows.map((h) => (
        <li key={h.industry} className="rounded-lg border border-border/60 px-3 py-2 text-[13px]">
          <div className="font-semibold">{h.industry} · {h.breadth} 只涨停</div>
          <p className="text-[12px] text-muted-foreground">龙头 {h.leader_name}（{h.leader_code}）{h.leader_boards == null ? "" : ` ${h.leader_boards} 板`} {h.leader_seal ? `首封 ${h.leader_seal}` : ""} · 连板占比 {h.intensity == null ? "—" : rate(h.intensity)} · 连续 {h.persistence} 张</p>
          <p className="mt-1">{h.names.map((n) => `${n.name}${n.limit_days == null ? "" : `${n.limit_days}板`}`).join("、")}{h.names_more ? ` 等 ${h.names_more} 只` : ""}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{h.note}</p>
        </li>
      ))}
    </ul>
  );
}

function DiffusionList({ rows, note }: { rows: InsightDiffusion[]; note: string | null }) {
  if (!rows.length) return <p role="status" className="text-[13px] text-muted-foreground">{note ?? "还没有扩散信号。"}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((d) => (
        <li key={d.industry} className="rounded-lg border border-border/60 px-3 py-2 text-[13px]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <b>{d.industry}</b>
            <span className="font-mono">{d.breadth_prev} → {d.breadth_now}</span>
            <Rel v={d.reliability} />
            <span className="text-[11px] text-muted-foreground">{d.baseline_clock} → {d.latest_clock} · 龙头 {d.leader_name}</span>
          </div>
          <ul className="list-disc space-y-1 pl-4 text-[12px]">
            {d.evidence.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function insightSummary(v: LiveInsightView): string {
  const lines = [
    `盯盘 · 实时洞察 ${v.date} ${v.clock} ${v.phase_label}。${v.freshness}`,
    `资金口径：${v.board_caliber}`,
    v.anomalies.length ? `资金变化：${v.anomalies.map((a) => a.explanation).join(" ")}` : "没有越过阈值的板块资金变化。",
    v.accumulation.length ? `个股净额形态：${v.accumulation.map((a) => `${a.name} ${a.statement}`).join(" ")}` : "没有个股分钟资金样本。",
    v.diffusion.length ? `扩散：${v.diffusion.map((d) => d.evidence.join("")).join(" ")}` : (v.diffusion_note ?? "没有扩散信号。"),
    "这些是已经发生的公开数据的统计描述，不是买卖建议。疑似建仓不是机构持仓。",
  ];
  return lines.join("\n");
}

export function InsightBody({ v, error, paused }: { v: LiveInsightView; error: string | null; paused: boolean }) {
  const up = v.market.breadth?.exchanges.reduce((s, x) => s + (x.up ?? 0), 0);
  const down = v.market.breadth?.exchanges.reduce((s, x) => s + (x.down ?? 0), 0);
  const breadthKnown = v.market.breadth?.exchanges.some((x) => x.up != null || x.down != null);
  return (
    <div className="space-y-4">
      <div className={cn("rounded-lg border px-3 py-2 text-[13px]", v.stale ? "border-warning/50 text-warning" : "border-border/60 text-muted-foreground")} role="status">
        <div className="text-foreground">{v.archive ? "历史采集" : v.phase_label} · {v.date} {v.latest_clock ?? v.clock} · {v.capture_count} 张快照{paused ? " · 页面在后台，已暂停刷新" : ""}</div>
        <p className="mt-1">{v.freshness}</p>
        {!v.enabled && <p className="mt-1">{v.disabled_reason}</p>}
        {error && <p className="mt-1">这次没取到：{error}。下面仍是上一份结果。</p>}
        {v.attempt?.reason && <p className="mt-1">最近一次采集：{OUTCOME[v.attempt.outcome] ?? v.attempt.outcome}。{v.attempt.reason}</p>}
      </div>

      <Section icon={Activity} title="盘中看盘" hint="指数行情时间不是今天就标非今日。涨跌家数来自东财三所口径，和涨跌分布的合计不是同一套，不互相凑。盘中情绪只在上游肯给今天的数时出现。">
        <div className="mb-3 flex flex-wrap gap-4">
          {v.market.indexes.map((q) => (
            <div key={q.code}>
              <div className="text-[11px] text-muted-foreground">{q.name}{q.quote_time && !q.today ? " · 非今日" : ""}</div>
              <div className={cn("font-mono text-lg font-semibold tabular-nums", pctColor(q.change_pct))}>{finite(q.price) == null ? "没取到" : q.price} <span className="text-sm">{signed(q.change_pct)}</span></div>
              {q.quote_time && <div className="text-[10px] text-muted-foreground">行情时间 {q.quote_time}</div>}
            </div>
          ))}
          {!v.market.indexes.length && <p className="text-[13px] text-muted-foreground">还没有指数快照。</p>}
        </div>
        <p className="text-[13px]">三所涨跌家数：{breadthKnown ? `上涨 ${up} · 下跌 ${down}` : "没取到"}{v.market.breadth?.date ? ` · 上游日期 ${v.market.breadth.date}` : ""}</p>
        {v.market.breadth_note && <p className="mt-1 text-[12px] text-warning">{v.market.breadth_note}</p>}
        <p className="mt-2 text-[13px]">盘中情绪：{v.market.live ? `涨停 ${v.market.live.limit_up ?? "—"} · 炸板 ${v.market.live.broken ?? "—"} · 跌停 ${v.market.live.limit_down ?? "—"} · 最高 ${v.market.live.highest_board ?? "—"} 板${v.market.live.as_of ? ` · ${v.market.live.as_of}` : ""}` : (v.market.live_reason ?? "没有")}</p>
      </Section>

      <Section icon={Waves} title="板块资金与时间变化" hint={v.board_caliber} caliber={v.board_source === "sina" ? "新浪流入减流出，不能和东财主力净额比。" : "东财主力净额，今日累计，单位元。"}>
        <h4 className="mb-2 text-[12px] font-semibold">行业</h4>
        <BoardTable rows={v.industry} label="行业板块资金" />
        <h4 className="mb-2 mt-4 text-[12px] font-semibold">概念</h4>
        <BoardTable rows={v.concept} label="概念板块资金" />
      </Section>

      <Section icon={Radio} title="可解释的资金变化" hint="净额变化达到 1.5 亿元，或名次至少跳 12 位且变化达到 0.5 亿元，才标出来。对照必须是 2–40 分钟内的同一口径，午休两边不比。">
        <Anomalies rows={v.anomalies} note={v.anomaly_note} />
      </Section>

      <Section icon={Layers} title="疑似低波动净流入" hint="只在涨跌幅绝对值不超过 4%、连续竞价里净额累计逐步抬升时出现。这不是机构建仓记录。">
        <Flows rows={v.accumulation} />
      </Section>

      <Section icon={Layers} title="热点结构与扩散" hint="龙头是该行业涨停里板位最高、首封更早的那只。扩散要求原龙头还在，且同行业至少新多 2 只。相关概念只来自这只龙头的东财概念归属。">
        <Hotspots rows={v.hotspots} />
        <div className="mt-3"><DiffusionList rows={v.diffusion} note={v.diffusion_note} /></div>
      </Section>

      <GapsAndSource gaps={v.gaps} source={v.source} />
      <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
        {v.limits.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

export function InsightTab({ date, refreshNonce }: { date: string | null; refreshNonce: number }) {
  const { data, error, live } = useLiveInsight(date, refreshNonce);
  useAiPage(data ? { key: `watch:insight:${data.date}`, title: `盯盘 · 实时洞察 ${data.date}`, context: insightSummary(data), suggestions: ["这些板块资金变化和涨跌是同向还是背离", "哪些扩散只是一张快照，样本还不够", "疑似净流入用的是哪套公开口径"] } : null);
  if (!data) {
    return <div className="glass p-6"><p role="status" className="text-sm text-muted-foreground">{error ? `实时洞察这次没取到：${error}` : live ? "实时洞察加载中…" : "页面在后台，先不刷新。"}</p></div>;
  }
  return <InsightBody v={data} error={error} paused={!live} />;
}

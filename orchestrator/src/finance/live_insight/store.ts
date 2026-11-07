/** 实时洞察只写在数据目录的 live-insight/ 下，不进台账，也不改复盘快照。 */
import fs from "node:fs";
import path from "node:path";

import { appendJsonl, writeJson, readJsonIfExists } from "../../fsutil.ts";
import { safePath, type ServiceContext } from "../../service.ts";
import { SNAPSHOT_SCHEMA, type CaptureSnapshot, type InsightAttempt } from "./types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function insightDayDir(ctx: Pick<ServiceContext, "dataRoot">, date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`实时洞察日期不合法:${date}`);
  return safePath(ctx, "live-insight", date);
}

export function snapshotsFile(ctx: Pick<ServiceContext, "dataRoot">, date: string): string {
  return path.join(insightDayDir(ctx, date), "snapshots.jsonl");
}

export function attemptFile(ctx: Pick<ServiceContext, "dataRoot">): string {
  return safePath(ctx, "live-insight", "last-attempt.json");
}

export function readSnapshots(ctx: Pick<ServiceContext, "dataRoot">, date: string): { snapshots: CaptureSnapshot[]; dropped: number } {
  const file = snapshotsFile(ctx, date);
  if (!fs.existsSync(file)) return { snapshots: [], dropped: 0 };
  const text = fs.readFileSync(file, "utf8");
  const snapshots: CaptureSnapshot[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as CaptureSnapshot;
      if (row?.schema !== SNAPSHOT_SCHEMA || row.date !== date || typeof row.captured_at !== "string" || typeof row.clock !== "string") {
        dropped += 1;
        continue;
      }
      snapshots.push(row);
    } catch {
      dropped += 1;
    }
  }
  snapshots.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  return { snapshots, dropped };
}

export function appendSnapshot(ctx: Pick<ServiceContext, "dataRoot">, snap: CaptureSnapshot): void {
  appendJsonl(snapshotsFile(ctx, snap.date), snap);
}

export function writeAttempt(ctx: Pick<ServiceContext, "dataRoot">, attempt: InsightAttempt): void {
  writeJson(attemptFile(ctx), attempt);
}

export function readAttempt(ctx: Pick<ServiceContext, "dataRoot">): InsightAttempt | null {
  const row = readJsonIfExists<InsightAttempt>(attemptFile(ctx));
  if (!row || typeof row.at !== "string" || typeof row.outcome !== "string") return null;
  return row;
}

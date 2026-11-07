/**
 * 实时洞察的刷新。页面开着才问；切走就停。
 * 读接口不写盘。只有后端说 capture_due，或用户点了刷新，才 POST 采集。服务端单飞，多窗口不会叠请求。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";
import { cleanReason } from "./api";
import type { LiveInsightView } from "./insightTypes";

const MAX_BACKOFF_MS = 60_000;

export function nextInsightDelay(okMs: number | null, failures: number): number {
  const base = okMs && okMs > 0 ? okMs : 20_000;
  if (failures <= 0) return base;
  return Math.min(base * 2 ** failures, MAX_BACKOFF_MS);
}

export function useLiveInsight(date: string | null, refreshNonce: number) {
  const [data, setData] = useState<LiveInsightView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const kick = useRef<((force?: boolean) => void) | null>(null);
  const nonce = useRef(refreshNonce);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let ctl: AbortController | null = null;
    let failures = 0;
    let lastMs: number | null = null;
    let inFlight = false;
    const clear = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };

    const loop = async (force = false) => {
      if (cancelled || inFlight) return;
      clear();
      if (document.hidden) {
        setLive(false);
        timer = window.setTimeout(() => void loop(false), 10_000);
        return;
      }
      setLive(true);
      inFlight = true;
      ctl = new AbortController();
      try {
        let view = await backend.liveInsight<LiveInsightView>(date, ctl.signal);
        if (cancelled) return;
        setData(view);
        if (!date && (force || view.capture_due)) {
          view = await backend.liveInsightCapture<LiveInsightView>(force);
          if (cancelled) return;
          setData(view);
        }
        setError(null);
        failures = 0;
        lastMs = view.poll_ms;
      } catch (e) {
        if (cancelled || ctl.signal.aborted) return;
        failures += 1;
        setError(cleanReason(e instanceof Error ? e.message : String(e)) || "原因不明");
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      timer = window.setTimeout(() => void loop(false), nextInsightDelay(lastMs, failures));
    };
    kick.current = (force) => { void loop(!!force); };
    if (nonce.current !== refreshNonce) {
      nonce.current = refreshNonce;
      void loop(true);
    } else {
      void loop(false);
    }
    const onVisible = () => { if (!document.hidden && !cancelled) void loop(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clear();
      ctl?.abort();
      kick.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [date, refreshNonce]);

  const refresh = useCallback(() => kick.current?.(true), []);
  return { data, error, live, refresh };
}

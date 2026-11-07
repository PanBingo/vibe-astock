/** 实时洞察的视图登记。和复盘、原盯盘分开，上游合并时只多这一行导入。 */
import { registerView } from "../../views.ts";
import { liveInsightAct, liveInsightView } from "./view.ts";

registerView({
  id: "live_insight",
  label: "盯盘 · 实时洞察",
  run: (ctx, query, signal) => liveInsightView(ctx, query, signal),
  act: (ctx, body, signal) => liveInsightAct(ctx, body, signal),
});

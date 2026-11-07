/** 涨停观察池视图。读不写；写入只走 POST 和收盘任务。 */
import { registerView } from "../../views.ts";
import { limitWatchAct, limitWatchView } from "./view.ts";

registerView({
  id: "limit_watch",
  label: "涨停观察池",
  run: (ctx, query, signal) => Promise.resolve(limitWatchView(ctx, query, signal)),
  act: (ctx, body, signal) => limitWatchAct(ctx, body, signal),
});

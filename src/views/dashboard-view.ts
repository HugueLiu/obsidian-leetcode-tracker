import { ItemView, WorkspaceLeaf } from "obsidian";
import type LeetCodeTrackerPlugin from "../main";
import { isAccepted } from "../types";
import type { RecordRow } from "../types";

export const DASHBOARD_VIEW_TYPE = "leetcode-tracker-dashboard";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 热力图的格子尺寸与周数 */
const CELL = 12;
const CELL_GAP = 3;
const HEAT_WEEKS = 53;

const pad2 = (n: number) => String(n).padStart(2, "0");
/** 用本地日期做键，跨时区不会错位到前一天 */
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function fmtShort(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function statusText(s: string): string {
  switch ((s || "").trim().toUpperCase()) {
    case "AC": return "通过";
    case "WA": return "解答错误";
    case "TLE": return "超时";
    case "MLE": return "内存超限";
    case "RE": return "运行错误";
    case "CE": return "编译错误";
    case "OLE": return "输出超限";
    default: return s || "其他";
  }
}

/**
 * 看板：把刷题数据做成一眼能看懂的仪表盘。
 * 形态参考 Note Pulse —— 连击天数、活动热力图、趋势、分布。
 * 全部用原生 DOM + SVG 手绘，不引任何三方图表库，插件体积不变。
 */
export class DashboardView extends ItemView {
  private heatRo?: ResizeObserver;
  private plugin: LeetCodeTrackerPlugin;
  private root!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LeetCodeTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "刷题看板";
  }

  getIcon(): string {
    return "bar-chart-3";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("lc-dash-root");
    this.root = this.contentEl.createDiv({ cls: "lc-dash" });
    await this.reload();
  }

  async reload(): Promise<void> {
    this.root.empty();
    this.heatRo?.disconnect();
    const rows = await this.plugin.records.allRows(this.app.vault.adapter);

    if (rows.length === 0) {
      this.root.createDiv({
        cls: "lc-dash-empty",
        text: "还没有提交记录，先同步一次再看板就有数据了。",
      });
      return;
    }

    this.renderKpis(rows);
    this.renderHeatmap(rows);
    this.renderRow2(rows);
    this.renderRow3(rows);
    this.renderRecent(rows);
    this.root.createDiv({ cls: "lc-dash-foot", text: `数据来自本地 records.csv，共 ${rows.length} 条提交` });
  }

  // ---------------------------------------------------------------- KPI

  private renderKpis(rows: RecordRow[]): void {
    const settings = this.plugin.data.settings;
    const all = this.plugin.problems.all();
    const visible = settings.showPaid ? all : all.filter((p) => !p.paidOnly);

    let done = 0;
    let ever = 0;
    for (const p of visible) {
      const st = this.plugin.records.stat(p.slug);
      if (this.plugin.resolver.status(p.slug, st) === "done") done++;
      if (this.plugin.resolver.everDone(p.slug, st)) ever++;
    }

    const solvedSlugs = new Set(rows.filter((r) => isAccepted(r.status)).map((r) => r.slug));
    const activeDays = new Set(rows.map((r) => ymd(new Date(r.submittedAt * 1000)))).size;
    const { current: streak, longest } = this.streaks(rows);
    const rate = visible.length ? Math.round((done / visible.length) * 100) : 0;

    const wrap = this.root.createDiv({ cls: "lc-kpis" });
    const kpi = (label: string, value: string, sub: string, cls = "") => {
      const box = wrap.createDiv({ cls: `lc-kpi ${cls}` });
      box.createDiv({ cls: "lc-kpi-label", text: label });
      box.createDiv({ cls: "lc-kpi-value", text: value });
      if (sub) box.createDiv({ cls: "lc-kpi-sub", text: sub });
    };

    kpi("本轮已刷", String(done), `共 ${visible.length} 题 · ${rate}%`, "is-hero");
    kpi("累计刷过", String(ever), `历史通过 ${ever} 道`);
    kpi("连续刷题", `${streak} 天`, `最长 ${longest} 天`);
    kpi("总提交", String(rows.length), `通过 ${rows.filter((r) => isAccepted(r.status)).length} 条`);
    kpi("覆盖题目", String(solvedSlugs.size), `活跃 ${activeDays} 天`);

    // 进度条单独一行，比塞在卡片里好读
    const bar = this.root.createDiv({ cls: "lc-progress" });
    const fill = bar.createDiv({ cls: "lc-progress-fill" });
    // 有进度但比例极小时给一条最小可见宽度，否则整条看起来是空的
    fill.style.width = `${Math.min(100, Math.max(rate > 0 ? 1.5 : 0, rate))}%`;

    // 两个口径不一致时点明差额，否则用户会以为数字打架
    if (ever > done) {
      this.root.createDiv({
        cls: "lc-kpi-note",
        text: `另有 ${ever - done} 道题在重置线之前通过，只计入累计、不计入本轮`,
      });
    }
  }

  private streaks(rows: RecordRow[]): { current: number; longest: number } {
    const days = new Set(rows.map((r) => ymd(new Date(r.submittedAt * 1000))));
    if (days.size === 0) return { current: 0, longest: 0 };

    // 当前连击：今天没提交就从昨天起算，避免早上一睁眼看到 0
    let current = 0;
    const cursor = startOfDay(new Date());
    if (!days.has(ymd(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (days.has(ymd(cursor))) {
      current++;
      cursor.setDate(cursor.getDate() - 1);
    }

    // 最长连击：把所有日期排序后逐日推进
    const sorted = [...days].sort();
    let longest = 1;
    let run = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1]);
      const cur = new Date(sorted[i]);
      prev.setDate(prev.getDate() + 1);
      if (ymd(prev) === ymd(cur)) {
        run++;
      } else {
        run = 1;
      }
      if (run > longest) longest = run;
    }
    return { current, longest };
  }

  // ---------------------------------------------------------------- 热力图

  private renderHeatmap(rows: RecordRow[]): void {
    const daily = new Map<string, number>();
    const dailyAc = new Map<string, number>();
    let max = 0;
    for (const r of rows) {
      const key = ymd(new Date(r.submittedAt * 1000));
      const n = (daily.get(key) ?? 0) + 1;
      daily.set(key, n);
      if (isAccepted(r.status)) dailyAc.set(key, (dailyAc.get(key) ?? 0) + 1);
      if (n > max) max = n;
    }

    const card = this.root.createDiv({ cls: "lc-card" });
    const head = card.createDiv({ cls: "lc-card-head" });
    head.createDiv({ cls: "lc-card-title", text: "提交热力图" });
    head.createDiv({ cls: "lc-card-hint", text: "最近一年 · 每格一天 · 颜色越深提交越多" });

    const heatWrap = card.createDiv({ cls: "lc-heat-wrap" });
    const scroller = heatWrap.createDiv({ cls: "lc-heat" });
    const weeks = HEAT_WEEKS;

    // 终点取本周的周六，起点再往前推 52 周，保证首列以周日开头
    const today = startOfDay(new Date());
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(start.getDate() - (weeks * 7 - 1));

    /**
     * 按容器可用宽度反推格子尺寸，让整张图横向刚好铺满：
     * 先定格子大小（8–20px），剩余宽度平均摊给间隙，于是不会出现半屏空白，
     * 也不会因为等比缩放把格子拉成歪的方块。
     */
    const draw = (avail: number): void => {
      scroller.empty();
      const cell = Math.max(8, Math.min(16, Math.floor((avail - (weeks - 1) * 2) / weeks)));
      const gap = Math.max(
        2,
        Math.min(12, Math.floor((avail - weeks * cell) / Math.max(1, weeks - 1)))
      );
      const w = weeks * cell + (weeks - 1) * gap;
      const h = 7 * cell + 6 * gap;

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.setAttribute("class", "lc-heat-svg");
      // 371 个格子不可能逐个 tab，退化成整图一个可读摘要
      svg.setAttribute("role", "img");
      svg.setAttribute(
        "aria-label",
        `过去一年提交热力图：共 ${rows.length} 次提交，${daily.size} 天有提交，单日最多 ${max} 次`
      );

      for (let week = 0; week < weeks; week++) {
        for (let dow = 0; dow < 7; dow++) {
          const d = new Date(start);
          d.setDate(start.getDate() + week * 7 + dow);
          if (d > today) continue;

          const key = ymd(d);
          const n = daily.get(key) ?? 0;
          /* 按固定阈值分档，而不是按「单日最多」线性四等分：
             后者在 max 偏大时会把 3 次和 8 次压进相邻档、颜色几乎一样，
             而用户读热力图时想知道的恰恰是「这天到底刷了几次」。 */
          const level = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 7 ? 3 : 4;

          const rect = document.createElementNS(SVG_NS, "rect");
          rect.setAttribute("x", String(week * (cell + gap)));
          rect.setAttribute("y", String(dow * (cell + gap)));
          rect.setAttribute("width", String(cell));
          rect.setAttribute("height", String(cell));
          rect.setAttribute("rx", "2");
          rect.setAttribute("class", `lc-heat-cell lc-heat-l${level}`);
          rect.setAttribute("data-date", key);
          rect.setAttribute("data-n", String(n));
          rect.setAttribute("data-ac", String(dailyAc.get(key) ?? 0));
          const title = document.createElementNS(SVG_NS, "title");
          title.textContent = `${key}　${n} 次提交`;
          rect.appendChild(title);
          svg.appendChild(rect);
        }
      }
      scroller.appendChild(svg);
    };

    // 首帧卡片可能还没量到宽度，先按 720 画一版，随后由监听器校正
    draw(scroller.clientWidth || 720);

    /* SVG 原生 <title> 要悬停 1 秒才弹，而且 ResizeObserver 每次重绘都会把
       rect 重建、提示中断，实际等于不可见 —— 改成自己画一个跟随鼠标的提示条 */
    const tip = heatWrap.createDiv({ cls: "lc-heat-tip" });
    const showTip = (ev: MouseEvent): void => {
      const el = ev.target instanceof Element ? ev.target : null;
      const cell = el ? (el.closest(".lc-heat-cell") as Element | null) : null;
      if (!cell) {
        tip.removeClass("is-on");
        return;
      }
      const date = cell.getAttribute("data-date") ?? "";
      const n = Number(cell.getAttribute("data-n") ?? "0");
      const ac = Number(cell.getAttribute("data-ac") ?? "0");
      tip.setText(n === 0 ? `${date}　没有提交` : `${date}　${n} 次提交 · ${ac} 次通过`);
      tip.addClass("is-on");

      // 先显示再量尺寸，才能正确判断右边和下边会不会溢出
      const box = heatWrap.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = ev.clientX - box.left + 14;
      let y = ev.clientY - box.top + 16;
      if (x + tw > box.width - 4) x = Math.max(4, ev.clientX - box.left - tw - 14);
      if (y + th > box.height - 4) y = Math.max(4, ev.clientY - box.top - th - 12);
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };
    this.registerDomEvent(scroller, "mousemove", showTip);
    this.registerDomEvent(scroller, "mouseleave", () => tip.removeClass("is-on"));

    let lastW = -1;
    const ro = new ResizeObserver(() => {
      const cur = scroller.clientWidth;
      if (cur <= 0 || Math.abs(cur - lastW) < 12) return;
      lastW = cur;
      draw(cur);
    });
    ro.observe(scroller);
    this.heatRo = ro;
    this.register(() => ro.disconnect());

    const legend = card.createDiv({ cls: "lc-heat-legend" });
    legend.createDiv({ cls: "lc-heat-legend-label", text: "少" });
    for (let i = 0; i <= 4; i++) {
      const box = legend.createDiv({ cls: `lc-heat-key lc-heat-l${i}` });
      box.style.width = "12px";
      box.style.height = "12px";
    }
    legend.createDiv({ cls: "lc-heat-legend-label", text: "多" });
    legend.createDiv({
      cls: "lc-heat-max",
      text: `单日 0 / 1 / 2–3 / 4–7 / 8+ 次 · 最多 ${max} 次`,
    });
  }

  // ---------------------------------------------------------------- 月度趋势 + 难度

  private renderRow2(rows: RecordRow[]): void {
    const grid = this.root.createDiv({ cls: "lc-dash-grid" });
    this.renderMonthly(grid, rows);
    this.renderDifficulty(grid);
  }

  private renderMonthly(parent: HTMLElement, rows: RecordRow[]): void {
    const card = parent.createDiv({ cls: "lc-card" });
    const head = card.createDiv({ cls: "lc-card-head" });
    head.createDiv({ cls: "lc-card-title", text: "月度提交趋势" });
    head.createDiv({ cls: "lc-card-hint", text: "最近 12 个月" });

    const now = new Date();
    const buckets: { label: string; count: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ label: `${d.getMonth() + 1}月`, count: 0 });
    }
    const startMonth = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime() / 1000;
    for (const r of rows) {
      if (r.submittedAt < startMonth) continue;
      const d = new Date(r.submittedAt * 1000);
      const offset = (d.getFullYear() - new Date(startMonth * 1000).getFullYear()) * 12 +
        (d.getMonth() - new Date(startMonth * 1000).getMonth());
      if (offset >= 0 && offset < 12) buckets[offset].count++;
    }

    const max = Math.max(1, ...buckets.map((b) => b.count));
    const chart = card.createDiv({ cls: "lc-bars" });
    for (const b of buckets) {
      const col = chart.createDiv({ cls: "lc-bar-col" });
      const track = col.createDiv({ cls: "lc-bar-track" });
      const fill = track.createDiv({ cls: "lc-bar-fill" });
      fill.style.height = `${Math.max(b.count ? 6 : 0, (b.count / max) * 100)}%`;
      const val = col.createDiv({ cls: "lc-bar-val", text: b.count ? String(b.count) : "" });
      // 抬高 4px，数字不要压在柱顶色块上
      val.style.bottom = `calc(${Math.max(b.count ? 8 : 0, (b.count / max) * 100)}% + 4px)`;
      col.createDiv({ cls: "lc-bar-label", text: b.label });
    }
  }

  private renderDifficulty(parent: HTMLElement): void {
    const settings = this.plugin.data.settings;
    const all = this.plugin.problems.all();
    const visible = settings.showPaid ? all : all.filter((p) => !p.paidOnly);

    const card = parent.createDiv({ cls: "lc-card" });
    const head = card.createDiv({ cls: "lc-card-head" });
    head.createDiv({ cls: "lc-card-title", text: "难度进度" });
    head.createDiv({ cls: "lc-card-hint", text: "粗条=本轮 · 细条=累计" });

    const groups: { key: string; name: string }[] = [
      { key: "EASY", name: "简单" },
      { key: "MEDIUM", name: "中等" },
      { key: "HARD", name: "困难" },
    ];

    const listEl = card.createDiv({ cls: "lc-diff-list" });
    for (const g of groups) {
      const list = visible.filter((p) => p.difficulty === g.key);
      let done = 0;
      let ever = 0;
      for (const p of list) {
        const st = this.plugin.records.stat(p.slug);
        if (this.plugin.resolver.status(p.slug, st) === "done") done++;
        if (this.plugin.resolver.everDone(p.slug, st)) ever++;
      }
      const pct = list.length ? (done / list.length) * 100 : 0;
      const pctEver = list.length ? (ever / list.length) * 100 : 0;

      const line = listEl.createDiv({ cls: "lc-diff-line" });
      const top = line.createDiv({ cls: "lc-diff-top" });
      top.createDiv({ cls: `lc-diff-name lc-diff--${g.key.toLowerCase()}`, text: g.name });
      top.createDiv({
        cls: "lc-diff-num",
        text: `${done} / ${list.length} · 累计 ${ever}`,
      });

      // 本轮条：实心。累计条：细且降透明度，这样重置线抬高后仍能看出历史厚度
      const track = line.createDiv({ cls: "lc-diff-track" });
      const fill = track.createDiv({ cls: `lc-diff-fill lc-diff--${g.key.toLowerCase()}` });
      fill.style.width = `${pct}%`;

      const trackEver = line.createDiv({ cls: "lc-diff-track lc-diff-track--thin" });
      const fillEver = trackEver.createDiv({ cls: `lc-diff-fill lc-diff--${g.key.toLowerCase()}` });
      fillEver.style.width = `${pctEver}%`;
    }
  }

  // ---------------------------------------------------------------- 结果分布 + 标签

  private renderRow3(rows: RecordRow[]): void {
    const grid = this.root.createDiv({ cls: "lc-dash-grid" });
    this.renderVerdicts(grid, rows);
    this.renderTags(grid);
  }

  private renderVerdicts(parent: HTMLElement, rows: RecordRow[]): void {
    const card = parent.createDiv({ cls: "lc-card" });
    const head = card.createDiv({ cls: "lc-card-head" });
    head.createDiv({ cls: "lc-card-title", text: "提交结果分布" });

    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = (r.status || "?").trim().toUpperCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const total = rows.length || 1;

    // 一条横向堆叠条 + 图例，比饼图好读且不需要计算路径
    const stack = card.createDiv({ cls: "lc-stack" });
    for (const [k, n] of sorted) {
      const seg = stack.createDiv({ cls: `lc-stack-seg lc-verdict-${k.toLowerCase()}` });
      seg.style.width = `${(n / total) * 100}%`;
      seg.setAttr("title", `${statusText(k)} ${n} 条（${Math.round((n / total) * 100)}%）`);
    }

    const list = card.createDiv({ cls: "lc-verdict-list" });
    for (const [k, n] of sorted.slice(0, 6)) {
      const item = list.createDiv({ cls: "lc-verdict-item" });
      const dot = item.createDiv({ cls: `lc-verdict-dot lc-verdict-${k.toLowerCase()}` });
      dot.style.width = "8px";
      dot.style.height = "8px";
      item.createDiv({ cls: "lc-verdict-name", text: statusText(k) });
      item.createDiv({ cls: "lc-verdict-num", text: `${n} · ${Math.round((n / total) * 100)}%` });
    }
  }

  private renderTags(parent: HTMLElement): void {
    const settings = this.plugin.data.settings;
    const all = this.plugin.problems.all();
    const visible = settings.showPaid ? all : all.filter((p) => !p.paidOnly);

    const card = parent.createDiv({ cls: "lc-card" });
    const head = card.createDiv({ cls: "lc-card-head" });
    head.createDiv({ cls: "lc-card-title", text: "累计刷过的高频标签" });
    head.createDiv({ cls: "lc-card-hint", text: "Top 8 · 按累计口径" });

    const tagCount = new Map<string, number>();
    for (const p of visible) {
      // 按累计口径统计：本轮只有几题时，按本轮统计会让所有标签都是 1、条形一样长
      const st = this.plugin.records.stat(p.slug);
      if (!this.plugin.resolver.everDone(p.slug, st)) continue;
      const tags = p.tagsCn.length ? p.tagsCn : p.tags;
      for (const t of tags) {
        tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      }
    }

    const sorted = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (sorted.length === 0) {
      card.createDiv({ cls: "lc-card-hint", text: "还没有已刷题目" });
      return;
    }

    const max = sorted[0][1] || 1;
    const list = card.createDiv({ cls: "lc-tag-list" });
    for (const [name, n] of sorted) {
      const line = list.createDiv({ cls: "lc-tag-line" });
      line.createDiv({ cls: "lc-tag-name", text: name });
      const track = line.createDiv({ cls: "lc-tag-track" });
      const fill = track.createDiv({ cls: "lc-tag-fill" });
      fill.style.width = `${(n / max) * 100}%`;
      line.createDiv({ cls: "lc-tag-num", text: `${n}` });
    }
  }

  // ---------------------------------------------------------------- 最近动态

  private renderRecent(rows: RecordRow[]): void {
    const card = this.root.createDiv({ cls: "lc-card" });
    const head = card.createDiv({ cls: "lc-card-head" });
    head.createDiv({ cls: "lc-card-title", text: "最近提交" });
    head.createDiv({ cls: "lc-card-hint", text: "最新 12 条" });

    const titleOf = (slug: string) => {
      const p = this.plugin.problems.get(slug);
      return p ? `${p.frontendId}. ${p.titleCn || p.title}` : slug;
    };

    const list = card.createDiv({ cls: "lc-recent-list" });
    for (const r of rows.slice(0, 12)) {
      const line = list.createDiv({ cls: "lc-recent-row" });
      line.createDiv({ cls: "lc-recent-time", text: fmtShort(r.submittedAt) });
      const st = line.createDiv({ cls: "lc-recent-status" });
      if (isAccepted(r.status)) st.addClass("is-ac");
      st.setText(statusText(r.status));
      line.createDiv({ cls: "lc-recent-title", text: titleOf(r.slug) });
      line.createDiv({ cls: "lc-recent-lang", text: r.lang || "" });
    }
  }
}

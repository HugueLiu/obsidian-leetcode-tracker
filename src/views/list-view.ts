import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LeetCodeTrackerPlugin from "../main";
import type { Status } from "../domain/status";
import type { ProblemRow, RecordRow, RoundStat } from "../types";
import { isAccepted } from "../types";

export const VIEW_TYPE = "leetcode-tracker-view";

const ROW_HEIGHT = 34;
const OVERSCAN = 8;
/** 行内展开的每条提交行高 */
const DETAIL_ROW_HEIGHT = 26;
/** 行内最多展开多少条，再多让人去提交记录页 */
const DETAIL_MAX = 8;

function statusLabel(s: string): string {
  switch ((s || "").trim().toUpperCase()) {
    case "AC": return "通过";
    case "WA": return "解答错误";
    case "TLE": return "超时";
    case "MLE": return "内存超限";
    case "RE": return "运行错误";
    case "CE": return "编译错误";
    case "OLE": return "输出超限";
    case "IE": return "内部错误";
    default: return s || "—";
  }
}

interface RowVM {
  problem: ProblemRow;
  status: Status;
  lastAcAt: number;
  acCount: number;
  submitCount: number;
}

/** pending = 本轮没做，包含从未通过的题和以前通过过的题 */
type StatusFilter = "all" | "done" | "notDone" | "stale" | "pending";

function fmtDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 轮次要精确到分，同一天重置两次才区分得开 */
function fmtDateTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sortKey(p: ProblemRow): number {
  const n = Number(p.frontendId);
  if (!Number.isNaN(n) && n > 0) return n;
  // LCR / 面试题等非数字题号排在后面
  return 1_000_000 + (p.frontendId.charCodeAt(0) || 0);
}

export class ProblemListView extends ItemView {
  private plugin: LeetCodeTrackerPlugin;

  private filterStatus: StatusFilter = "all";
  private filterDifficulty: string = "all";
  private filterTag: string = "all";
  private searchText = "";

  private allRows: RowVM[] = [];
  private filtered: RowVM[] = [];

  /** 行内展开的题目 slug（同时只展开一道题），下方直接列出该题的提交 */
  private expandedSlug: string | null = null;
  private expandedDetail: RecordRow[] = [];

  private viewport!: HTMLElement;
  private spacer!: HTMLElement;
  private rowsEl!: HTMLElement;
  private headerText!: HTMLElement;
  private subtitle!: HTMLElement;
  private statusTabs: Record<string, HTMLElement> = {};
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf = 0;

  /** 轮次选择：null = 按最新状态（现有判定），数字 = 只看第 N 轮 */
  private selectedRound: number | null = null;
  private roundStats: RoundStat[] = [];
  private roundBar!: HTMLElement;
  private roundSelect!: HTMLSelectElement;

  /** 登录态失效横幅（只在 cookie 真失效时出现，普通网络错误不打扰） */
  private authBanner!: HTMLElement;
  private authText!: HTMLElement;
  /** 头部右侧的登录状态：未登录显示按钮，已登录显示头像 + 用户名 */
  private authBox!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LeetCodeTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "LeetCode 刷题记录";
  }

  getIcon(): string {
    return "list-checks";
  }

  async onOpen(): Promise<void> {
    this.rebuildLayout();
    this.reloadData();
    this.render();

    // 首屏时 viewport 的 clientHeight 往往还是 0，渲染行数会严重偏少（列表下半截空白）。
    // 用 ResizeObserver 在真正完成布局后再补渲染一次，之后跟随面板缩放自动重算。
    this.resizeObserver = new ResizeObserver(() => this.scheduleRenderRows());
    this.resizeObserver.observe(this.viewport);
    this.scheduleRenderRows();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeRaf) {
      window.cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = 0;
    }
  }

  /** 把补渲染合并到下一帧，避免缩放时连续重建 DOM */
  private scheduleRenderRows(): void {
    if (this.resizeRaf) return;
    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.renderRows();
    });
  }

  private rebuildLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("lc-root");

    // 头部
    const header = root.createDiv({ cls: "lc-header" });
    const headerMain = header.createDiv({ cls: "lc-header-main" });
    this.headerText = headerMain.createDiv({ cls: "lc-header-title" });
    this.subtitle = headerMain.createDiv({ cls: "lc-subtitle" });
    this.authBox = header.createDiv({ cls: "lc-authbox" });

    // 登录态横幅：比一闪而过的 Notice 更可靠，过期后一直挂着直到修好
    this.authBanner = root.createDiv({ cls: "lc-auth-banner is-hidden" });
    this.authText = this.authBanner.createDiv({ cls: "lc-auth-text" });
    this.authBanner
      .createEl("button", { cls: "lc-auth-btn", text: "重新登录" })
      .addEventListener("click", () => void this.plugin.relogin());

    // 轮次条：有重置历史时才显示
    this.roundBar = root.createDiv({ cls: "lc-roundbar" });
    this.roundSelect = this.roundBar.createEl("select", { cls: "lc-round-select" });
    this.roundSelect.addEventListener("change", () => {
      const v = this.roundSelect.value;
      this.selectedRound = v === "0" ? null : Number(v);
      // 切到历史轮次时直接看这一轮做了哪些题
      if (this.selectedRound !== null) this.filterStatus = "done";
      this.reloadData();
      this.render();
    });

    // 状态 tab
    const tabs = root.createDiv({ cls: "lc-tabs" });
    // 四个 tab 统一到「本轮」这一个坐标：已刷 = 本轮做的，本轮未做 = 剩下的全部，
    // 「以前做过」是「本轮未做」里需要重刷的那部分（子集，不是并列项）
    const defs: { key: StatusFilter; label: string }[] = [
      { key: "all", label: "全部" },
      { key: "pending", label: "本轮未做" },
      { key: "done", label: "已刷" },
      { key: "stale", label: "以前做过" },
    ];
    for (const d of defs) {
      const t = tabs.createDiv({ cls: "lc-tab", text: d.label });
      // 计数直接挂在 tab 上，替代原本要靠副标题长句解释的口径
      t.createSpan({ cls: "lc-tab-count" });
      t.setAttribute("role", "tab");
      t.tabIndex = 0;
      const activate = (): void => {
        this.filterStatus = d.key;
        this.render();
      };
      t.addEventListener("click", activate);
      t.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate();
        }
      });
      this.statusTabs[d.key] = t;
    }

    // 筛选行
    const filters = root.createDiv({ cls: "lc-filters" });

    const diffSel = filters.createEl("select", { cls: "lc-select" });
    for (const [v, label] of [
      ["all", "全部难度"],
      ["EASY", "简单"],
      ["MEDIUM", "中等"],
      ["HARD", "困难"],
    ] as [string, string][]) {
      diffSel.createEl("option", { value: v, text: label });
    }
    diffSel.addEventListener("change", () => {
      this.filterDifficulty = diffSel.value;
      this.render();
    });

    const tagSel = filters.createEl("select", { cls: "lc-select" });
    tagSel.createEl("option", { value: "all", text: "全部标签" });
    this.plugin.problems.allTags().forEach((t) => {
      tagSel.createEl("option", { value: t.slug, text: t.name });
    });
    tagSel.addEventListener("change", () => {
      this.filterTag = tagSel.value;
      this.render();
    });

    const search = filters.createEl("input", {
      cls: "lc-search",
      attr: { type: "search", placeholder: "题号 / 标题 / slug" },
    });
    search.addEventListener("input", () => {
      this.searchText = search.value.trim().toLowerCase();
      this.render();
    });

    // 列表视口
    this.viewport = root.createDiv({ cls: "lc-viewport" });
    this.spacer = this.viewport.createDiv({ cls: "lc-spacer" });
    this.rowsEl = this.spacer.createDiv({ cls: "lc-rows" });

    this.viewport.addEventListener("scroll", () => this.renderRows());

    // 底部
    const footer = root.createDiv({ cls: "lc-footer" });
    const btn = (label: string, fn: () => void, cls = "lc-btn") => {
      const b = footer.createEl("button", { cls, text: label });
      b.addEventListener("click", fn);
      return b;
    };
    btn("提交记录", () => void this.plugin.openRecordsView());
    btn("同步提交", () => this.plugin.syncSubmissions());
    btn("刷新题库", () => this.plugin.syncProblems());

    // 重置全部：两段式确认。误触会清空手动标记且无法恢复，不能用单击直接执行
    let armed = false;
    let armTimer = 0;
    const resetBtn = btn("重置全部", () => {
      if (!armed) {
        armed = true;
        resetBtn.setText("再点一次确认");
        resetBtn.addClass("mod-warning");
        armTimer = window.setTimeout(() => {
          armed = false;
          resetBtn.setText("重置全部");
          resetBtn.removeClass("mod-warning");
        }, 4000);
        return;
      }
      armed = false;
      window.clearTimeout(armTimer);
      resetBtn.setText("重置全部");
      resetBtn.removeClass("mod-warning");
      void this.plugin.resetAll();
    });
    this.register(() => window.clearTimeout(armTimer));
    this.rowsEl.addEventListener("contextmenu", (ev) => ev.preventDefault());
  }

  /** 从插件状态重建内存行数据 */
  reloadData(): void {
    const problems = this.plugin.problems.all();
    const resolver = this.plugin.resolver;
    const records = this.plugin.records;

    this.roundStats = this.plugin.getRoundStats();
    const sel = this.roundStats.find((r) => r.index === this.selectedRound) ?? null;
    if (this.selectedRound !== null && !sel) this.selectedRound = null;

    this.allRows = problems.map((p) => {
      const stat = records.stat(p.slug);
      let status: Status = resolver.status(p.slug, stat);

      // 历史轮：按该轮时间窗内是否产生过 Accepted 判定；
      // 当前轮仍走 resolver，保证与顶部计数、主视图完全一致
      if (sel && !sel.isCurrent) {
        const end = sel.end ?? Number.POSITIVE_INFINITY;
        status = records.hasAcInRange(p.slug, sel.start, end) ? "done" : "notDone";
      }

      return {
        problem: p,
        status,
        lastAcAt: stat.lastAcAt,
        acCount: stat.acCount,
        submitCount: stat.submitCount,
      };
    });

    this.allRows.sort((a, b) => sortKey(a.problem) - sortKey(b.problem));
    this.applyFilters();
    this.buildRoundOptions();
  }

  /**
   * 头部登录状态。未登录 → 圆点 + 「未登录」+ 登录按钮；
   * 已登录 → 头像 + 用户名。头像加载失败退回收首字母，不留破图。
   */
  private renderAuthBox(): void {
    const el = this.authBox;
    el.empty();
    el.removeAttribute("title");

    const { username, avatarUrl } = this.plugin.data.settings;
    const expired = this.plugin.authState === "expired";
    const signedIn = !!username && !expired;

    el.toggleClass("is-unauth", !signedIn);

    if (!signedIn) {
      el.createDiv({ cls: "lc-auth-dot" });
      el.createDiv({ cls: "lc-auth-label", text: expired ? "登录已过期" : "未登录" });
      const btn = el.createEl("button", { cls: "lc-auth-login", text: "登录" });
      btn.addEventListener("click", () => void this.plugin.relogin());
      return;
    }

    if (avatarUrl) {
      const img = el.createEl("img", { cls: "lc-avatar" });
      img.src = avatarUrl;
      img.alt = username;
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.replaceWith(this.fallbackAvatar(username)));
      el.appendChild(img);
    } else {
      el.appendChild(this.fallbackAvatar(username));
    }

    el.createDiv({ cls: "lc-auth-name", text: username });
    el.setAttribute("title", `已登录：${username}`);
  }

  private fallbackAvatar(username: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "lc-avatar lc-avatar--fallback";
    d.setText(username.slice(0, 1).toUpperCase() || "?");
    return d;
  }

  private buildRoundOptions(): void {
    if (!this.roundBar) return;

    const stats = this.roundStats;
    this.roundBar.toggleClass("is-hidden", stats.length === 0);
    if (stats.length === 0) return;

    this.roundSelect.empty();
    // 轮次总数并入首项文案，省掉单独一行说明
    this.roundSelect.createEl("option", { value: "0", text: `最新状态 · 共 ${stats.length} 轮` });
    for (let i = stats.length - 1; i >= 0; i--) {
      const s = stats[i];
      const span = `${fmtDateTime(s.start)} → ${s.isCurrent ? "进行中" : fmtDateTime(s.end!)}`;
      this.roundSelect.createEl("option", {
        value: String(s.index),
        text: `第 ${s.index} 轮 · ${span} · ${s.count} 题`,
      });
    }
    this.roundSelect.value = this.selectedRound === null ? "0" : String(this.selectedRound);
  }

  private applyFilters(): void {
    const q = this.searchText;
    const statusF = this.filterStatus;
    const diffF = this.filterDifficulty;
    const tagF = this.filterTag;
    const showStale = this.plugin.data.settings.showStale;
    const showPaid = this.plugin.data.settings.showPaid;

    this.filtered = this.allRows.filter((r) => {
      const p = r.problem;
      if (p.paidOnly && !showPaid) return false;
      if (p.retired) return false;

      // 「本轮未做」收的是从未通过和以前通过过两类，后者不属于本轮
      if (statusF === "pending") {
        if (r.status !== "notDone" && r.status !== "stale") return false;
      } else if (statusF !== "all" && r.status !== statusF) {
        return false;
      }
      // 切到「以前做过」或「本轮未做」时穿透 showStale：这两个入口本身就是为看这些题
      if (statusF !== "stale" && statusF !== "pending" && r.status === "stale" && !showStale) return false;
      if (diffF !== "all" && p.difficulty !== diffF) return false;
      if (tagF !== "all" && !p.tags.includes(tagF)) return false;

      if (q) {
        const hay = `${p.frontendId} ${p.slug} ${p.title} ${p.titleCn}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /** 外部数据变化后调用 */
  render(): void {
    this.applyFilters();

    // 进度分母只算"当前可见"的题：会员题按设置决定是否计入，绝不能拿 4498 当分母
    const visible = this.allRows.filter(
      (r) => !r.problem.retired && (!r.problem.paidOnly || this.plugin.data.settings.showPaid)
    );
    const done = visible.filter((r) => r.status === "done").length;
    // 累计 = 历史上 AC 过的题，不受重置线影响
    const ever = visible.filter((r) =>
      this.plugin.resolver.everDone(r.problem.slug, this.plugin.records.stat(r.problem.slug))
    ).length;

    const sel = this.roundStats.find((r) => r.index === this.selectedRound) ?? null;

    if (sel) {
      this.headerText.empty();
      this.headerText.appendText(`第 ${sel.index} 轮 · 已完成`);
      this.headerText.createSpan({ cls: "lc-num", text: String(done) });
      this.headerText.appendText("题");
      this.subtitle.setText(
        `${fmtDateTime(sel.start)} → ${sel.isCurrent ? "现在" : fmtDateTime(sel.end!)}`
      );
    } else {
      this.headerText.empty();
      this.headerText.appendText("本轮已刷");
      this.headerText.createSpan({ cls: "lc-num", text: `${done} / ${visible.length}` });
      this.subtitle.setText(`累计 ${ever} 道`);
    }

    // 数字直接摆在 tab 上，口径靠自身闭合：已刷 + 本轮未做 = 全部
    const counts: Record<string, number> = { all: visible.length, done: 0, notDone: 0, stale: 0 };
    for (const r of visible) counts[r.status] = (counts[r.status] ?? 0) + 1;
    // 13 + 3695 = 3708，让 tab 上的数字自己闭合
    counts.pending = counts.notDone + counts.stale;
    for (const [key, el] of Object.entries(this.statusTabs)) {
      el.toggleClass("is-active", this.filterStatus === key);
      el.querySelector(".lc-tab-count")?.setText(String(counts[key] ?? 0));
    }

    const expired = this.plugin.authState === "expired";
    this.authBanner.toggleClass("is-hidden", !expired);
    if (expired) this.authText.setText("登录态已过期，自动同步已暂停");

    this.renderAuthBox();

    this.viewport.scrollTop = 0;
    this.renderRows();
    this.scheduleRenderRows();
  }

  /** 当前展开行的序号，-1 表示没有展开 */
  private expandedIndex(): number {
    if (!this.expandedSlug) return -1;
    return this.filtered.findIndex((v) => v.problem.slug === this.expandedSlug);
  }

  /**
   * 展开区高度必须和 CSS 实际占用一致，否则行高小于内容高度，
   * 多出来的部分被 .lc-row 的 overflow 裁掉（曾把底部链接切了一半）。
   * 现值：上下 padding 16 + more 行 18 + 底部链接行 22。
   */
  private detailHeight(): number {
    if (!this.expandedSlug) return 0;
    const shown = Math.min(this.expandedDetail.length, DETAIL_MAX);
    const more = this.expandedDetail.length > DETAIL_MAX ? 20 : 0;
    // 宁可多留 6px：多算只是底部多一条空白，少算会把「看全部」链接裁掉一半
    return shown * DETAIL_ROW_HEIGHT + 18 + more + 26;
  }

  private renderRows(): void {
    const total = this.filtered.length;

    if (total === 0) {
      this.spacer.style.height = "0px";
      this.rowsEl.empty();
      this.rowsEl.createDiv({
        cls: "lc-empty",
        text: this.plugin.problems.size === 0 ? "题库为空，请先点「刷新题库」" : "没有符合筛选条件的题目",
      });
      return;
    }

    // 展开行的存在让行高不再等长，改成前缀和定位
    const idx = this.expandedIndex();
    const extra = idx >= 0 ? this.detailHeight() : 0;
    const offsets = new Array<number>(total + 1);
    let acc = 0;
    for (let i = 0; i < total; i++) {
      offsets[i] = acc;
      acc += ROW_HEIGHT + (i === idx ? extra : 0);
    }
    offsets[total] = acc;
    this.spacer.style.height = `${acc}px`;

    const top = this.viewport.scrollTop;
    const h = this.viewport.clientHeight || 400;

    // 二分找第一个底边越过视口顶部的行
    let lo = 0;
    let hi = total - 1;
    let first = total;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const bottom = offsets[mid] + ROW_HEIGHT + (mid === idx ? extra : 0);
      if (bottom > top) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const start = Math.max(0, first - OVERSCAN);
    let end = first;
    while (end < total && offsets[end] < top + h) end++;
    end = Math.min(total, end + OVERSCAN);

    this.rowsEl.style.transform = `translateY(${offsets[start]}px)`;
    this.rowsEl.empty();

    for (let i = start; i < end; i++) {
      this.rowsEl.appendChild(this.buildRow(this.filtered[i], i === idx));
    }
  }

  private buildRow(vm: RowVM, expanded: boolean): HTMLElement {
    const p = vm.problem;
    const row = document.createElement("div");
    row.className = `lc-row lc-row--${vm.status}`;
    if (expanded) row.addClass("is-expanded");
    row.style.height = `${ROW_HEIGHT + (expanded ? this.detailHeight() : 0)}px`;

    const main = document.createElement("div");
    main.className = "lc-row-main";
    row.appendChild(main);

    // 状态点由 CSS 画形状（实心/半实/空心），不依赖字体里的符号；
    // 会员题把这个点换成同色系的锁，颜色继续承担状态语义
    const mark = main.createDiv({ cls: "lc-mark" });
    mark.setAttr(
      "aria-label",
      vm.status === "done" ? "已刷" : vm.status === "stale" ? "以前做过" : "未刷"
    );
    if (p.paidOnly) {
      mark.addClass("is-lock");
      setIcon(mark, "lock");
      mark.setAttr("aria-label", `会员题 · ${mark.getAttribute("aria-label")}`);
    }

    main.createDiv({ cls: "lc-id", text: p.frontendId });
    const titleWrap = main.createDiv({ cls: "lc-title-cell" });
    titleWrap.createDiv({ cls: "lc-title-main", text: p.titleCn || p.title });
    if (p.titleCn && p.title) {
      titleWrap.createDiv({ cls: "lc-title-sub", text: p.title });
    }

    main.createDiv({
      cls: `lc-diff lc-diff--${p.difficulty.toLowerCase()}`,
      text: p.difficulty === "EASY" ? "简单" : p.difficulty === "MEDIUM" ? "中等" : "困难",
    });

    const tagsWrap = main.createDiv({ cls: "lc-tags" });
    (p.tagsCn.length ? p.tagsCn : p.tags).slice(0, 2).forEach((t) => {
      tagsWrap.createDiv({ cls: "lc-tag", text: t });
    });
    if ((p.tagsCn.length || p.tags.length) > 2) {
      tagsWrap.createDiv({ cls: "lc-tag lc-tag--more", text: `+${(p.tagsCn.length || p.tags.length) - 2}` });
    }

    const when = main.createDiv({ cls: "lc-when" });
    if (vm.lastAcAt) {
      when.setText(fmtDate(vm.lastAcAt));
      when.setAttr("title", `AC ${vm.acCount} 次，提交 ${vm.submitCount} 次`);
    } else if (vm.submitCount) {
      when.setText("仅提交");
    }

    // 提交条数本身就是入口：点一下就地展开，不再藏进右键菜单
    const cnt = main.createDiv({
      cls: "lc-cntbtn",
      text: vm.submitCount ? `${vm.submitCount} 条` : "—",
    });
    if (vm.submitCount === 0) cnt.addClass("is-empty");
    cnt.setAttr("title", expanded ? "收起提交历史" : "展开这道题的提交历史");
    cnt.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void this.toggleHistory(vm);
    });

    main.addEventListener("click", (ev) => this.openRowMenu(ev, vm));

    if (expanded) row.appendChild(this.buildDetail());
    return row;
  }

  private buildDetail(): HTMLElement {
    const box = document.createElement("div");
    box.className = "lc-row-detail";
    box.addEventListener("click", (ev) => ev.stopPropagation());

    const rows = [...this.expandedDetail].sort((a, b) => b.submittedAt - a.submittedAt);
    rows.slice(0, DETAIL_MAX).forEach((r) => {
      const line = document.createElement("div");
      line.className = "lc-det-row";
      line.createDiv({ cls: "lc-det-time", text: fmtDateTime(r.submittedAt) });
      const st = line.createDiv({ cls: "lc-det-status" });
      if (isAccepted(r.status)) st.addClass("is-ac");
      st.setText(statusLabel(r.status));
      line.createDiv({ cls: "lc-det-lang", text: r.lang || "" });
      line.createDiv({ cls: "lc-det-rt", text: r.runtime || "" });
      box.appendChild(line);
    });

    if (this.expandedDetail.length > DETAIL_MAX) {
      box.createDiv({
        cls: "lc-det-more",
        text: `还有 ${this.expandedDetail.length - DETAIL_MAX} 条…`,
      });
    }

    const foot = box.createDiv({ cls: "lc-det-foot" });
    const link = foot.createDiv({ cls: "lc-det-link", text: "在提交记录页看全部" });
    link.addEventListener("click", () => void this.plugin.openRecordsView());
    return box;
  }

  /** 展开 / 收起某道题的提交历史，同时只展开一题 */
  private async toggleHistory(vm: RowVM): Promise<void> {
    const slug = vm.problem.slug;

    if (this.expandedSlug === slug) {
      this.expandedSlug = null;
      this.expandedDetail = [];
      this.renderRows();
      this.scheduleRenderRows();
      return;
    }

    const rows = await this.plugin.records.historyFor(this.app.vault.adapter, slug);
    if (rows.length === 0) {
      new Notice(`${vm.problem.titleCn || vm.problem.title}：本地还没有这道题的提交记录`);
      return;
    }

    this.expandedSlug = slug;
    this.expandedDetail = rows;
    this.renderRows();
    this.scrollExpandedIntoView();
    this.scheduleRenderRows();
  }

  /** 展开行在视口下缘时，把整块明细滚进可视区，否则点了看不到内容 */
  private scrollExpandedIntoView(): void {
    if (!this.expandedSlug) return;
    const idx = this.expandedIndex();
    if (idx < 0) return;

    // 展开行之前的行都是普通行高，行顶部就是 idx * ROW_HEIGHT
    const rowTop = idx * ROW_HEIGHT;
    const rowH = ROW_HEIGHT + this.detailHeight();
    const vTop = this.viewport.scrollTop;
    const vh = this.viewport.clientHeight || 400;

    if (rowTop + rowH > vTop + vh) {
      this.viewport.scrollTop = Math.max(0, rowTop + rowH - vh);
    } else if (rowTop < vTop) {
      this.viewport.scrollTop = rowTop;
    }
  }

  private openRowMenu(ev: MouseEvent, vm: RowVM): void {
    const p = vm.problem;
    const menu = new Menu();

    const base = this.plugin.resolver.baseline(p.slug);
    const desc = base
      ? `（本题重置线 ${fmtDate(base)}）`
      : "（无重置线）";

    if (vm.status === "done") {
      menu.addItem((i) =>
        i.setTitle(`重置此题 ${desc}`).setIcon("rotate-ccw").onClick(() => this.plugin.resetOne(p.slug))
      );
    } else {
      menu.addItem((i) =>
        i.setTitle("标记为已刷").setIcon("check").onClick(() => this.plugin.markDone(p.slug))
      );
      if (base) {
        menu.addItem((i) =>
          i.setTitle("撤销本题重置").setIcon("undo-2").onClick(() => this.plugin.clearResetOne(p.slug))
        );
      }
    }

    menu.addItem((i) =>
      i.setTitle("在力扣打开").setIcon("external-link").onClick(() => {
        window.open(p.url, "_blank");
      })
    );

    menu.addItem((i) =>
      i
        .setTitle("展开提交历史")
        .setIcon("history")
        .onClick(() => void this.toggleHistory(vm))
    );

    menu.showAtMouseEvent(ev);
  }
}

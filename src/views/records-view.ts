import { ItemView, WorkspaceLeaf } from "obsidian";
import type LeetCodeTrackerPlugin from "../main";
import { isAccepted } from "../types";
import type { RecordRow } from "../types";

export const RECORDS_VIEW_TYPE = "leetcode-tracker-records";

const ROW_HEIGHT = 34;
const OVERSCAN = 8;

/** 提交记录要精确到分，同一道题连着提交好几次才分得开 */
function fmtFull(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 提交记录页：把 records.csv 里的每一条提交原样列出来。
 * 和主面板的区别是——主面板每题一行（看"算不算刷过"），这页每次提交一行（看"我做过什么"）。
 */
export class RecordsView extends ItemView {
  private plugin: LeetCodeTrackerPlugin;

  private rows: RecordRow[] = [];
  private filtered: RecordRow[] = [];
  private onlyAc = false;

  private viewport!: HTMLElement;
  private spacer!: HTMLElement;
  private rowsEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private tabAll!: HTMLElement;
  private tabAc!: HTMLElement;

  private resizeRaf = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LeetCodeTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return RECORDS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "提交记录";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.buildLayout();
    this.viewport.addEventListener("scroll", () => this.renderRows());

    // 虚拟滚动必须等容器真正有高度再算可见区间，否则首帧只渲染几行
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(this.viewport);

    await this.reload();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeRaf) {
      window.cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = 0;
    }
  }

  private scheduleRender(): void {
    if (this.resizeRaf) return;
    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.renderRows();
    });
  }

  /** 供 plugin.refreshViews 调用：同步完自动重扫文件 */
  async reload(): Promise<void> {
    this.rows = await this.plugin.records.allRows(this.app.vault.adapter);
    this.applyFilter();
  }

  private applyFilter(): void {
    this.filtered = this.onlyAc ? this.rows.filter((r) => isAccepted(r.status)) : this.rows;
    const acCount = this.rows.filter((r) => isAccepted(r.status)).length;
    const slugCount = new Set(this.rows.map((r) => r.slug)).size;
    this.statsEl.setText(`共 ${this.rows.length} 条 · 通过 ${acCount} 条 · 覆盖 ${slugCount} 道题`);

    this.tabAll.toggleClass("is-active", !this.onlyAc);
    this.tabAc.toggleClass("is-active", this.onlyAc);

    this.viewport.scrollTop = 0;
    this.renderRows();
    this.scheduleRender();
  }

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("lc-root");

    const header = root.createDiv({ cls: "lc-header" });
    const headerMain = header.createDiv({ cls: "lc-header-main" });
    headerMain.createDiv({ cls: "lc-header-title", text: "提交记录" });
    this.statsEl = headerMain.createDiv({ cls: "lc-subtitle" });

    const tabs = root.createDiv({ cls: "lc-tabs" });
    this.tabAll = tabs.createDiv({ cls: "lc-tab is-active", text: "全部" });
    this.tabAc = tabs.createDiv({ cls: "lc-tab", text: "仅通过" });
    this.tabAll.addEventListener("click", () => {
      this.onlyAc = false;
      this.applyFilter();
    });
    this.tabAc.addEventListener("click", () => {
      this.onlyAc = true;
      this.applyFilter();
    });

    this.viewport = root.createDiv({ cls: "lc-viewport" });
    this.spacer = this.viewport.createDiv({ cls: "lc-spacer" });
    this.rowsEl = this.spacer.createDiv({ cls: "lc-rows" });
  }

  private renderRows(): void {
    const total = this.filtered.length;
    this.spacer.style.height = `${total * ROW_HEIGHT}px`;

    if (total === 0) {
      this.rowsEl.empty();
      this.rowsEl.createDiv({
        cls: "lc-empty",
        text: this.plugin.records.count === 0 ? "还没有提交记录，先在设置页同步一次" : "没有符合条件的记录",
      });
      return;
    }

    const top = this.viewport.scrollTop;
    const h = this.viewport.clientHeight || 400;
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(total, Math.ceil((top + h) / ROW_HEIGHT) + OVERSCAN);

    this.rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
    this.rowsEl.empty();
    for (let i = start; i < end; i++) {
      this.rowsEl.appendChild(this.buildRow(this.filtered[i]));
    }
  }

  private buildRow(rec: RecordRow): HTMLElement {
    const p = this.plugin.problems.get(rec.slug);
    const ok = isAccepted(rec.status);

    const row = document.createElement("div");
    row.className = `lc-recrow lc-recrow--${ok ? "ac" : "fail"}`;
    row.style.height = `${ROW_HEIGHT}px`;

    row.createDiv({ cls: "lc-rec-time", text: fmtFull(rec.submittedAt) });
    row.createDiv({ cls: `lc-rec-status ${ok ? "is-ac" : "is-fail"}`, text: rec.status });

    const titleWrap = row.createDiv({ cls: "lc-rec-title" });
    titleWrap.createDiv({ cls: "lc-rec-id", text: p ? p.frontendId : "—" });
    titleWrap.createDiv({ cls: "lc-rec-name", text: p ? p.titleCn || p.title : rec.slug });

    row.createDiv({ cls: "lc-rec-lang", text: rec.lang || "" });
    row.createDiv({ cls: "lc-rec-rt", text: rec.runtime || "" });

    row.addEventListener("click", () => {
      const url = p?.url ?? `https://leetcode.cn/problems/${rec.slug}/`;
      window.open(url, "_blank");
    });
    return row;
  }
}

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import type { DataAdapter } from "obsidian";
import { LeetCodeClient, LcError } from "./api/client";
import type { Account } from "./api/client";
import { isEmbeddedLoginAvailable, openEmbeddedLogin } from "./auth/embedded-login";
import { StatusResolver } from "./domain/status";
import { ProblemStore } from "./store/problems";
import { RecordStore } from "./store/records";
import { EventStore } from "./store/events";
import { AcStatusStore } from "./store/ac-status";
import { syncProblems } from "./sync/problems-sync";
import { describeSyncError, importProgress, syncPerProblemHistory, syncSubmissions } from "./sync/submissions-sync";
import { ProblemListView, VIEW_TYPE } from "./views/list-view";
import { RecordsView, RECORDS_VIEW_TYPE } from "./views/records-view";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./views/dashboard-view";
import { TrackerSettingTab } from "./views/settings-tab";
import { DEFAULT_RESET, DEFAULT_SETTINGS } from "./state";
import type { PluginData } from "./state";
import type { ResetEvent, RoundStat } from "./types";

export default class LeetCodeTrackerPlugin extends Plugin {
  data!: PluginData;
  client!: LeetCodeClient;
  problems!: ProblemStore;
  records!: RecordStore;
  events!: EventStore;
  acStatus!: AcStatusStore;
  resolver!: StatusResolver;

  /**
   * 登录态结论。只有真正拿到 userStatus.isSignedIn 才有意义，
   * 所以默认 unknown —— 面板据此决定要不要挂"去重新登录"横幅。
   */
  authState: "unknown" | "ok" | "expired" = "unknown";

  private timerId: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadPluginData();

    const adapter = this.app.vault.adapter;
    this.client = new LeetCodeClient(() => this.data.settings.cookie);
    this.problems = new ProblemStore();
    this.records = new RecordStore();
    this.events = new EventStore();
    this.acStatus = new AcStatusStore();
    await this.problems.load(adapter);
    await this.records.load(adapter);
    await this.events.load(adapter);
    await this.acStatus.load(adapter);
    this.resolver = new StatusResolver(this.data.reset);
    this.resolver.setAcKnown(this.acStatus.asSet());
    await this.seedEventsIfNeeded(adapter);

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new ProblemListView(leaf, this));
    this.registerView(RECORDS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RecordsView(leaf, this));
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DashboardView(leaf, this));

    this.addRibbonIcon("list-checks", "LeetCode 刷题记录", () => void this.activateView("tab"));
    this.addRibbonIcon("bar-chart-3", "LeetCode 刷题看板", () => void this.openDashboardView());

    this.addCommand({
      id: "open-tracker",
      name: "打开刷题记录面板（主区域）",
      callback: () => void this.activateView("tab"),
    });
    this.addCommand({
      id: "open-tracker-sidebar",
      name: "在侧边栏打开刷题记录面板",
      callback: () => void this.activateView("sidebar"),
    });
    this.addCommand({
      id: "open-records",
      name: "打开提交记录页",
      callback: () => void this.openRecordsView(),
    });
    this.addCommand({
      id: "open-dashboard",
      name: "打开刷题看板",
      callback: () => void this.openDashboardView(),
    });
    this.addCommand({
      id: "sync-problems",
      name: "同步题库",
      callback: () => void this.syncProblems(),
    });
    this.addCommand({
      id: "sync-submissions",
      name: "同步提交记录（增量）",
      callback: () => void this.syncSubmissions(),
    });
    this.addCommand({
      id: "sync-full-history",
      name: "全量对齐提交历史",
      callback: () => void this.syncFullHistory(),
    });
    this.addCommand({
      id: "import-progress",
      name: "导入力扣已有进度",
      callback: () => void this.importProgress(),
    });
    this.addCommand({
      id: "reset-all",
      name: "重置全部题目为未刷",
      callback: () => void this.resetAll(),
    });

    this.addSettingTab(new TrackerSettingTab(this.app, this));
    this.restartTimer();

    this.app.workspace.onLayoutReady(() => {
      if (this.problems.size === 0) {
        void this.bootstrapProblems();
      } else if (this.data.settings.autoSyncOnLoad) {
        window.setTimeout(() => void this.timedSync(), 2500);
      }
      // 面板头部的登录状态需要真实值，启动时探一次（有 cookie 才发请求）
      void this.refreshAccount();
    });
  }

  onunload(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  // ---------------------------------------------------------------- 数据

  async loadPluginData(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    this.data = {
      settings: Object.assign({}, DEFAULT_SETTINGS, saved?.settings ?? {}),
      reset: Object.assign({}, DEFAULT_RESET, saved?.reset ?? {}),
    };
    this.data.reset.perSlugBaseline = this.data.reset.perSlugBaseline || {};
    this.data.reset.manualOn = this.data.reset.manualOn || [];
    this.data.reset.manualOff = this.data.reset.manualOff || [];
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  /**
   * 兼容旧数据：data.json 里可能已有基线但没有事件日志（早期版本行为）。
   * 此时把已有基线补记成事件，让轮次历史从这一刻起可用。
   */
  private async seedEventsIfNeeded(adapter: DataAdapter): Promise<void> {
    if (this.events.all.length > 0) return;
    const r = this.data.reset;
    const seed: ResetEvent[] = [];

    if (r.globalBaseline > 0) seed.push({ at: r.globalBaseline, kind: "all", slug: "" });
    for (const [slug, at] of Object.entries(r.perSlugBaseline)) {
      if (at > 0) seed.push({ at, kind: "single", slug });
    }

    if (seed.length > 0) {
      seed.sort((a, b) => a.at - b.at);
      await this.events.appendMany(adapter, seed);
    }
  }

  // ---------------------------------------------------------------- 定时

  restartTimer(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    const mins = this.data.settings.syncIntervalMinutes;
    if (!mins || mins <= 0) return;
    this.timerId = window.setInterval(() => void this.timedSync(), mins * 60 * 1000);
    this.registerInterval(this.timerId);
  }

  private async timedSync(): Promise<void> {
    if (!this.data.settings.cookie) return;
    if (this.syncing) return;
    await this.syncSubmissions(true);
  }

  private async bootstrapProblems(): Promise<void> {
    new Notice("首次使用，正在拉取力扣题库（约 30 秒）…", 4000);
    await this.syncProblems();
  }

  // ---------------------------------------------------------------- 同步

  async syncProblems(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const notice = new Notice("正在同步题库…", 0);
    try {
      const r = await syncProblems(this.client, this.problems, this.acStatus, adapter, (fetched, total) => {
        notice.setMessage(`题库同步 ${fetched} / ${total || "?"}`);
      });
      notice.hide();
      // 题库同步顺带刷新了 AC 快照，判定层要立刻用上新数据
      this.resolver.setAcKnown(this.acStatus.asSet());
      new Notice(
        `题库已更新：${r.fetched} 道（${r.pages} 页，${(r.durationMs / 1000).toFixed(1)} 秒）` +
          (r.acSlugs > 0 ? `，同时确认 ${r.acSlugs} 道 AC 过的题` : "")
      );
      this.data.settings.lastProblemsSyncAt = Date.now();
      await this.savePluginData();
      this.refreshViews();
    } catch (e) {
      notice.hide();
      new Notice(`题库同步失败：${this.describeError(e)}`, 8000);
    }
  }

  /**
   * 全量对齐：全局 submissionList 只能翻最近 2000 条，但带 questionSlug
   * 单题查没有这个上限（实测能到 2016 年）。所以按题逐道扫一遍，
   * 靠 submission id 去重，把"本地有记录但缺几条"的题也补齐。
   */
  async syncFullHistory(): Promise<void> {
    if (this.syncing) {
      new Notice("正在同步，稍后再试");
      return;
    }

    const targets = [
      ...new Set([...this.acStatus.list(), ...this.records.allSlugs()]),
    ];
    if (targets.length === 0) {
      new Notice("还没有任何题目数据，请先点「刷新题库」或同步一次", 8000);
      return;
    }

    this.syncing = true;
    const notice = new Notice(`正在逐题对齐 ${targets.length} 道题…`, 0);
    try {
      const adapter = this.app.vault.adapter;
      const r = await syncPerProblemHistory(
        this.client,
        this.records,
        targets,
        adapter,
        {
          onProgress: (done, total, slug) =>
            notice.setMessage(`全量对齐 ${done} / ${total}　${slug}`),
        }
      );
      notice.hide();
      new Notice(
        `对齐完成：扫描 ${r.problems} 道题，读到 ${r.fetched} 条提交，新增 ${r.written} 条` +
          `（${(r.durationMs / 1000).toFixed(0)} 秒）`,
        10000
      );
      this.refreshViews();
    } catch (e) {
      notice.hide();
      new Notice(`对齐失败：${this.describeError(e)}`, 10000);
    } finally {
      this.syncing = false;
    }
  }

  async syncSubmissions(silent = false): Promise<void> {
    if (this.syncing) {
      if (!silent) new Notice("同步正在进行中");
      return;
    }
    if (!this.data.settings.cookie) {
      if (!silent) {
        new Notice("未配置 cookie，无法自动同步。可在设置里填写，或手动标记题目。", 6000);
      }
      return;
    }
    if (this.problems.size === 0) {
      if (!silent) new Notice("题库为空，请先刷新题库");
      return;
    }

    this.syncing = true;
    try {
      const adapter = this.app.vault.adapter;
      const r = await syncSubmissions(this.client, this.problems, this.records, adapter, {
        cursorId: this.data.settings.cursorSubmissionId,
        maxPages: 30,
      });

      this.authState = "ok";
      this.applyAccount(r.account);

      // 游标只在"确实接上了上次的位置"才前移。
      // 之前是无条件写 newestId —— 一旦积压超过翻页上限，没追到的那一段
      // 就永远跳过了（下次从新游标往前追，再也落不到那段）。
      // 现在没追到就保持旧游标，下次继续从旧位置追，靠 submission id 去重。
      const hadCursor = this.data.settings.cursorSubmissionId !== "";
      if (r.newestId && (!hadCursor || r.reachedCursor)) {
        this.data.settings.cursorSubmissionId = r.newestId;
        this.data.settings.cursorTimestamp = r.newestTimestamp;
      }
      this.data.settings.lastSyncAt = Date.now();
      await this.savePluginData();
      this.refreshViews();

      if (silent && r.written === 0 && r.pending.length === 0) return;

      if (r.fetched === 0) {
        new Notice(
          "没有读到任何提交记录。如果这些提交是在 leetcode.com（国际站）做的，leetcode.cn 这边不会有数据——两个站点不互通。",
          10000
        );
        return;
      }

      // 关键：一定要告诉用户本地总量。"新增 0 条"很容易被理解成"没拉到数据"，
      // 实际往往是数据早就齐了，只是没有新的提交。
      const parts: string[] = [];
      parts.push(
        r.written > 0
          ? `新增 ${r.written} 条`
          : `没有新的提交（本次读到 ${r.fetched} 条，本地已有）`
      );
      parts.push(`本地共 ${this.records.count} 条记录`);
      if (r.pending.length > 0) parts.push(`${r.pending.length} 条未能匹配题目`);
      if (!r.reachedCursor) parts.push("可能还有更早的记录，可在设置里做全量对齐");
      new Notice(`同步完成：${parts.join("，")}`, 6000);
    } catch (e) {
      if (e instanceof LcError && e.kind === "auth") {
        // 只有 cookie 真的失效才挂横幅。网络错误、限流、字段变更都不该误导用户去重贴 cookie
        this.authState = "expired";
        this.refreshViews();
      }
      new Notice(describeSyncError(e), 8000);
    } finally {
      this.syncing = false;
    }
  }

  async importProgress(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const notice = new Notice("正在导入已有进度…", 0);
    try {
      const r = await importProgress(this.client, this.problems, this.records, adapter);
      notice.hide();
      new Notice(
        `导入完成：账号做过 ${r.total} 道，写入 ${r.written} 条${r.unresolved ? `，${r.unresolved} 道未能匹配` : ""}（近似值，后续同步会精确覆盖）`,
        6000
      );
      this.refreshViews();
    } catch (e) {
      notice.hide();
      new Notice(describeSyncError(e), 8000);
    }
  }

  // ---------------------------------------------------------------- 重置

  async resetAll(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.data.reset.globalBaseline = now;
    this.data.reset.perSlugBaseline = {};
    this.data.reset.manualOn = [];
    this.data.reset.manualOff = [];
    await this.savePluginData();
    await this.events.append(this.app.vault.adapter, { at: now, kind: "all", slug: "" });
    this.resolver.apply(this.data.reset);
    this.refreshViews();
    new Notice(
      `已重置全部：第 ${this.currentRoundIndex()} 轮从 ${new Date(now * 1000).toLocaleString()} 开始`
    );
  }

  async clearResetAll(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.data.reset.globalBaseline = 0;
    this.data.reset.perSlugBaseline = {};
    await this.savePluginData();
    await this.events.append(this.app.vault.adapter, { at: now, kind: "clear_all", slug: "" });
    this.resolver.apply(this.data.reset);
    this.refreshViews();
    new Notice("已撤销全局重置，历史通过记录重新计入");
  }

  async resetOne(slug: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.data.reset.perSlugBaseline[slug] = now;
    this.data.reset.manualOff = this.data.reset.manualOff.filter((s) => s !== slug);
    this.data.reset.manualOn = this.data.reset.manualOn.filter((s) => s !== slug);
    await this.savePluginData();
    await this.events.append(this.app.vault.adapter, { at: now, kind: "single", slug });
    this.resolver.apply(this.data.reset);
    this.refreshViews();
    const p = this.problems.get(slug);
    new Notice(`已重置「${p?.titleCn || p?.title || slug}」：之后再做一遍才会重新算已刷`);
  }

  async clearResetOne(slug: string): Promise<void> {
    delete this.data.reset.perSlugBaseline[slug];
    await this.savePluginData();
    await this.events.append(this.app.vault.adapter, {
      at: Math.floor(Date.now() / 1000),
      kind: "clear_single",
      slug,
    });
    this.resolver.apply(this.data.reset);
    this.refreshViews();
    new Notice("已撤销该题的重置");
  }

  async markDone(slug: string): Promise<void> {
    this.data.reset.manualOff = this.data.reset.manualOff.filter((s) => s !== slug);
    if (!this.data.reset.manualOn.includes(slug)) this.data.reset.manualOn.push(slug);
    await this.savePluginData();
    await this.events.append(this.app.vault.adapter, {
      at: Math.floor(Date.now() / 1000),
      kind: "manual_on",
      slug,
    });
    this.resolver.apply(this.data.reset);
    this.refreshViews();
  }

  async markUndone(slug: string): Promise<void> {
    this.data.reset.manualOn = this.data.reset.manualOn.filter((s) => s !== slug);
    if (!this.data.reset.manualOff.includes(slug)) this.data.reset.manualOff.push(slug);
    await this.savePluginData();
    await this.events.append(this.app.vault.adapter, {
      at: Math.floor(Date.now() / 1000),
      kind: "manual_off",
      slug,
    });
    this.resolver.apply(this.data.reset);
    this.refreshViews();
  }

  // ---------------------------------------------------------------- 轮次

  private currentRoundIndex(): number {
    const rounds = this.events.buildRounds();
    return rounds.length;
  }

  /** 各轮的完成数量。当前轮沿用 StatusResolver 的判定，保证与顶部计数一致 */
  getRoundStats(): RoundStat[] {
    const rounds = this.events.buildRounds();
    const now = Math.floor(Date.now() / 1000);
    const showPaid = this.data.settings.showPaid;
    const problems = this.problems.all();

    return rounds.map((r) => {
      const end = r.end ?? now;
      const isCurrent = r.end === null;
      let count = 0;
      for (const p of problems) {
        if (p.retired) continue;
        if (p.paidOnly && !showPaid) continue;
        if (isCurrent) {
          if (this.resolver.status(p.slug, this.records.stat(p.slug)) === "done") count += 1;
        } else if (this.records.hasAcInRange(p.slug, r.start, end)) {
          count += 1;
        }
      }
      return { index: r.index, start: r.start, end: r.end, isCurrent, count };
    });
  }

  // ---------------------------------------------------------------- UI

  /** 记住账号信息，供面板头部展示头像和用户名 */
  applyAccount(account: Account): void {
    const changed =
      this.data.settings.username !== account.username ||
      this.data.settings.avatarUrl !== account.avatar;
    this.data.settings.username = account.username;
    this.data.settings.avatarUrl = account.avatar;
    if (changed) this.refreshViews();
  }

  /**
   * 探一次登录态，用于启动后尽快把头部状态变成真实值。
   * 网络类错误刻意不改状态 —— 不能把"暂时连不上"显示成"未登录"。
   */
  async refreshAccount(): Promise<void> {
    if (!this.data.settings.cookie) {
      this.authState = "unknown";
      this.applyAccount({ username: "", avatar: "" });
      return;
    }
    try {
      const account = await this.client.assertSignedIn();
      this.authState = "ok";
      this.applyAccount(account);
      await this.savePluginData();
      this.refreshViews();
    } catch (e) {
      if (e instanceof LcError && e.kind === "auth") {
        this.authState = "expired";
        this.applyAccount({ username: "", avatar: "" });
        this.refreshViews();
      }
    }
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof ProblemListView) {
        v.reloadData();
        v.render();
      }
    }
    // 提交记录页如果开着，同步完也要跟着刷新，不能停留在旧数据
    for (const leaf of this.app.workspace.getLeavesOfType(RECORDS_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof RecordsView) void v.reload();
    }
    // 看板同理，统计全部来自 records.csv，数据变了就得重算
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof DashboardView) void v.reload();
    }
  }

  /** 从面板横幅跳到设置页，并把 Cookie 输入框滚进视野 */  openAuthSettings(): void {
    const app = this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    };
    if (!app.setting) {
      new Notice("请到 设置 → 第三方插件 → LeetCode Tracker 填写 cookie", 6000);
      return;
    }
    app.setting.open();
    app.setting.openTabById(this.manifest.id);
    // 设置页是异步渲染的，等一帧再滚动
    window.setTimeout(() => {
      const el = document.querySelector(".lc-cookie-input");
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      (el as HTMLTextAreaElement | null)?.focus();
    }, 120);
  }

  /** 重新登录：内嵌窗口可用就开窗口，否则退回设置页手动粘贴 */
  async relogin(): Promise<void> {
    if (!isEmbeddedLoginAvailable()) {
      this.openAuthSettings();
      return;
    }
    await this.loginWithEmbeddedWindow();
  }

  /**
   * 内嵌登录。窗口里登录成功后由轮询回调接住 cookie —— 而且要先验一次
   * （userStatus 返回 isSignedIn）才落盘，避免把半截或失效的 cookie 存进去。
   */
  async loginWithEmbeddedWindow(): Promise<void> {
    const started = await openEmbeddedLogin(async (cookie) => {
      const prev = this.data.settings.cookie;
      this.data.settings.cookie = cookie;
      try {
        const account = await this.client.assertSignedIn();
        this.applyAccount(account);
        await this.savePluginData();
        this.authState = "ok";
        this.refreshViews();
        new Notice(`登录成功：${account.username}`, 5000);
        return account.username;
      } catch {
        // 验不过就还原，不覆盖用户已有的可用配置
        this.data.settings.cookie = prev;
        return null;
      }
    });

    if (!started) {
      new Notice("内嵌登录窗口不可用，请在设置里手动粘贴 cookie", 6000);
      this.openAuthSettings();
    }
  }

  /**
   * 打开面板。
   * mode = "tab"     → 主编辑区新标签页（默认，宽度足够，列表可读）
   * mode = "sidebar" → 右侧边栏（适合边看笔记边瞄进度，窄宽度由 CSS 容器查询自适应）
   */
  async activateView(mode: "tab" | "sidebar" = "tab"): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;

    if (!leaf) {
      leaf = mode === "sidebar" ? workspace.getRightLeaf(false) : workspace.getLeaf("tab");
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  /** 打开提交记录页：每次提交一行，已有就聚焦已有的那个标签页 */
  async openDashboardView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      if (!leaf) return;
      await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    this.refreshViews();
  }

  async openRecordsView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(RECORDS_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      if (!leaf) return;
      await leaf.setViewState({ type: RECORDS_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  describeError(e: unknown): string {
    if (e instanceof LcError) {
      switch (e.kind) {
        case "auth":
          return `登录态问题：${e.message}`;
        case "rate":
          return "力扣限流，请稍后再试";
        case "schema":
          return `力扣接口字段变化（改 src/api/queries.ts 即可）：${e.message}`;
        default:
          return e.message;
      }
    }
    return String(e);
  }
}

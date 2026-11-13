import type { DataAdapter } from "obsidian";
import type { LeetCodeClient } from "../api/client";
import { PROBLEM_PAGE_DELAY_MS, PROBLEM_PAGE_SIZE, problemUrl } from "../store/paths";
import type { ProblemStore } from "../store/problems";
import type { AcStatusStore } from "../store/ac-status";
import type { ProblemRow } from "../types";

export interface ProblemsSyncResult {
  total: number;
  fetched: number;
  pages: number;
  durationMs: number;
  /** 力扣侧确认 AC 过的 slug 数；未登录或全都没 AC 时为 0 */
  acSlugs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/**
 * 题库全量同步。
 *
 * 实测：limit 上限 100（传 1000 只回 100 条），总量约 4498，所以必须分页 45 次。
 * 中途失败不写盘 —— 保留旧题库继续可用，避免"拉了一半"把库变成残缺状态。
 */
export async function syncProblems(
  client: LeetCodeClient,
  store: ProblemStore,
  acStore: AcStatusStore,
  adapter: DataAdapter,
  onProgress?: (fetched: number, total: number) => void
): Promise<ProblemsSyncResult> {
  const started = Date.now();
  const rows: ProblemRow[] = [];
  const acSlugs: string[] = [];
  let skip = 0;
  let total = 0;
  let pages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await client.problemsPage(skip, PROBLEM_PAGE_SIZE);
    total = page.total || total;
    pages += 1;

    for (const q of page.questions) {
      rows.push({
        frontendId: String(q.frontendQuestionId ?? ""),
        slug: q.titleSlug,
        titleCn: q.titleCn || "",
        title: q.title || "",
        difficulty: q.difficulty,
        acRate: Number(q.acRate) || 0,
        paidOnly: Boolean(q.paidOnly),
        tags: (q.topicTags || []).map((t) => t.slug),
        tagsCn: (q.topicTags || []).map((t) => t.nameTranslated || t.name || t.slug),
        url: problemUrl(q.titleSlug),
        retired: false,
      });
      // 登录态下 status 是逐题真实状态：AC / TRIED / NOT_STARTED。
      // 这是唯一能覆盖"提交记录已滑出 2000 条窗口"的题的信息源。
      if (q.status === "AC") acSlugs.push(q.titleSlug);
    }

    onProgress?.(rows.length, total);

    skip += PROBLEM_PAGE_SIZE;
    if (!page.hasMore || skip >= total || page.questions.length === 0) break;
    await sleep(PROBLEM_PAGE_DELAY_MS);
  }

  store.replaceAll(rows);
  await store.save(adapter);

  // 只有真读到 AC 才写盘：匿名状态下 status 全是 NOT_STARTED，
  // 照写会把已登录时采集的快照清空
  if (acSlugs.length > 0) {
    await acStore.save(adapter, acSlugs);
  }

  return {
    total,
    fetched: rows.length,
    pages,
    durationMs: Date.now() - started,
    acSlugs: acSlugs.length,
  };
}

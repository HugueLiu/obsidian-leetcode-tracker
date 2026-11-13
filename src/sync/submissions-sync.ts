import type { DataAdapter } from "obsidian";
import type { Account, LeetCodeClient } from "../api/client";
import { LcError } from "../api/client";
import { resolveSlug } from "../domain/resolve";
import { isAccepted } from "../types";
import type { ProblemStore } from "../store/problems";
import type { RecordStore } from "../store/records";
import type { RecordRow } from "../types";

export interface PendingItem {
  title: string;
  url: string;
  timestamp: number;
  lang: string;
}

export interface SubmissionsSyncResult {
  fetched: number;
  written: number;
  pending: PendingItem[];
  /** 是否在翻页途中碰到了游标（true = 增量同步正常收敛） */
  reachedCursor: boolean;
  durationMs: number;
  newestId: string;
  newestTimestamp: number;
  pages: number;
  /** assertSignedIn 顺带拿到的账号信息，面板直接用它刷新头像和用户名 */
  account: Account;
}

/**
 * 提交记录增量同步。
 *
 * 关键点：
 * 1. 先 assertSignedIn —— 未登录时 submissionList 静默返回空数组，
 *    如果只看"返回为空"会误判成"一题没做"。
 * 2. 按 submission id 去重，幂等，重复同步不会产生脏数据。
 * 3. 映射不到题目的提交进 pending，不静默丢弃。
 */
export async function syncSubmissions(
  client: LeetCodeClient,
  problems: ProblemStore,
  records: RecordStore,
  adapter: DataAdapter,
  opts: { cursorId: string; maxPages: number; onPage?: (pages: number, fetched: number) => void }
): Promise<SubmissionsSyncResult> {
  const started = Date.now();
  const account = await client.assertSignedIn();

  const collected: RecordRow[] = [];
  const pending: PendingItem[] = [];
  let fetched = 0;
  let pages = 0;
  let reachedCursor = false;
  let newestId = "";
  let newestTimestamp = 0;

  // 实测服务端单页上限就是 40 条（limit 传 50/100/200 都只返回 40，不是报错），
  // 所以固定 40 页大小；offset 一律用"实际返回条数"推进，
  // 万一哪天服务端又截断，也不会因为按固定步长前进而漏掉中间那段。
  const pageSize = 40;
  let offset = 0;

  for (let p = 0; p < Math.max(1, opts.maxPages); p++) {
    const page = await client.submissionsPage(offset, pageSize);
    pages += 1;

    if (!page.submissions || page.submissions.length === 0) break;
    offset += page.submissions.length;

    for (const s of page.submissions) {
      fetched += 1;
      const ts = Number(s.timestamp) || 0;

      if (!newestId) {
        newestId = s.id;
        newestTimestamp = ts;
      }

      if (opts.cursorId && s.id === opts.cursorId) {
        reachedCursor = true;
        break;
      }

      const { slug } = resolveSlug(s, problems);
      if (!slug) {
        pending.push({ title: s.title || "", url: s.url || "", timestamp: ts, lang: s.lang || "" });
        continue;
      }

      collected.push({
        submissionId: s.id,
        slug,
        status: s.status || "",
        lang: s.lang || "",
        submittedAt: ts,
        runtime: s.runtime || "",
        memory: s.memory || "",
        source: "sync",
      });
    }

    if (reachedCursor) break;
    if (!page.hasNext) break;
  }

  opts.onPage?.(pages, fetched);

  let written = 0;
  if (collected.length > 0) {
    written = await records.appendRows(adapter, collected);
  }

  return {
    fetched,
    written,
    pending,
    reachedCursor,
    durationMs: Date.now() - started,
    newestId,
    newestTimestamp,
    pages,
    account,
  };
}

/**
 * 冷启动导入：一次拿全已做题（不分页）。
 * 只能拿到 lastSubmittedAt（最后一次"提交"，可能是 WA），所以这些记录标 source="import"，
 * 判定上要谨慎 —— 日常同步拿到精确 AC 后会覆盖成 sync。
 */
export async function importProgress(
  client: LeetCodeClient,
  problems: ProblemStore,
  records: RecordStore,
  adapter: DataAdapter
): Promise<{ total: number; written: number; unresolved: number }> {
  await client.assertSignedIn();
  const progress = await client.userProgress();

  const rows: RecordRow[] = [];
  let unresolved = 0;

  for (const q of progress.questions) {
    const slug = q.titleSlug || problems.byTitleLookup(q.title || "");
    if (!slug) {
      unresolved += 1;
      continue;
    }
    const ts = Number(q.lastSubmittedAt) || 0;
    if (!ts) continue;
    rows.push({
      submissionId: `import:${slug}`,
      slug,
      status: "Accepted",
      lang: "",
      submittedAt: ts,
      runtime: "",
      memory: "",
      source: "manual",
    });
  }

  const written = await records.appendRows(adapter, rows);
  return { total: progress.questions.length, written, unresolved };
}

export function describeSyncError(e: unknown): string {
  if (e instanceof LcError) {
    switch (e.kind) {
      case "auth":
        return `登录态问题：${e.message}`;
      case "rate":
        return "力扣限流，请稍后再试";
      case "schema":
        return `力扣接口字段变了（需要更新 src/api/queries.ts）：${e.message}`;
      default:
        return e.message;
    }
  }
  return String(e);
}

/** 逐题补全用的页大小，与服务端单页硬上限一致 */
const PER_PROBLEM_PAGE = 40;

export interface PerProblemResult {
  /** 实际检查的题目数 */
  problems: number;
  fetched: number;
  written: number;
  durationMs: number;
}

/**
 * 逐题补全提交历史。
 *
 * 为什么需要它：全局 submissionList 的 offset 硬上限是 2000（实测 offset=2000
 * 直接返回空数组），2020-06 之前的提交永远拿不到。但平台前端能显示 2017 年的记录，
 * 因为它带 questionSlug 逐题查 —— 同一接口加上该参数后，单题历史可以一直翻到底。
 *
 * 对"做过的每一道题"全量重扫，靠 submission id 去重自动补缺口。
 * 不能只补"本地零记录"的题 —— 实测抽样 15 题里有 6 道题是"有记录但缺几条"，
 * 那种缺口在 2000 条窗口之外，只有逐题扫才补得到。
 */
export async function syncPerProblemHistory(
  client: LeetCodeClient,
  records: RecordStore,
  slugs: string[],
  adapter: DataAdapter,
  opts: { onProgress?: (done: number, total: number, slug: string) => void } = {}
): Promise<PerProblemResult> {
  const started = Date.now();
  const collected: RecordRow[] = [];
  let fetched = 0;

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    opts.onProgress?.(i + 1, slugs.length, slug);

    let offset = 0;
    for (let p = 0; p < 20; p++) {
      const page = await client.submissionsPage(offset, PER_PROBLEM_PAGE, slug);
      if (!page.submissions || page.submissions.length === 0) break;

      for (const s of page.submissions) {
        fetched += 1;
        collected.push({
          submissionId: s.id,
          slug,
          status: s.status || "",
          lang: s.lang || "",
          submittedAt: Number(s.timestamp) || 0,
          runtime: s.runtime || "",
          memory: s.memory || "",
          source: "sync",
        });
      }

      // 按实际返回条数推进，服务端若截断也不会漏页
      offset += page.submissions.length;
      if (!page.hasNext) break;
    }
  }

  const written = await records.appendRows(adapter, collected);

  return {
    problems: slugs.length,
    fetched,
    written,
    durationMs: Date.now() - started,
  };
}

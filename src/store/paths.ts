/** 数据目录，相对 vault 根。以 "." 开头：Obsidian 不索引，Finder/git 可见。 */
export const DATA_DIR = ".leetcode";
export const PROBLEMS_CSV = `${DATA_DIR}/problems.csv`;
export const RECORDS_CSV = `${DATA_DIR}/records.csv`;
/** 重置/标记的变更日志，append-only，用于重建每一轮的边界 */
export const EVENTS_CSV = `${DATA_DIR}/events.csv`;
/**
 * 力扣判定"这题 AC 过"的权威快照，只有 slug 一列。
 * 由题库同步顺带采集（problemsetQuestionList 的 status 字段）。
 * 存在的理由：submissionList 的 offset 硬上限是 2000，
 * 更早的提交永远拿不到，只能靠这个补全"AC 过但记录在窗口外"的题。
 */
export const AC_SLUGS_CSV = `${DATA_DIR}/ac-slugs.csv`;

export const PROBLEMS_HEADER = [
  "frontend_id",
  "slug",
  "title_cn",
  "title",
  "difficulty",
  "ac_rate",
  "paid_only",
  "tags",
  "tags_cn",
  "url",
  "retired",
];

export const RECORDS_HEADER = [
  "submission_id",
  "slug",
  "status",
  "lang",
  "submitted_at",
  "runtime",
  "memory",
  "source",
];

export const EVENTS_HEADER = ["at", "kind", "slug"];

export function problemUrl(slug: string): string {
  return `https://leetcode.cn/problems/${slug}/`;
}

/** 题库全量拉取：实测 limit 上限 100，总量约 4498 */
export const PROBLEM_PAGE_SIZE = 100;
/** 每页之间的等待，避开力扣限流（社区经验约 20 req / 10s） */
export const PROBLEM_PAGE_DELAY_MS = 600;

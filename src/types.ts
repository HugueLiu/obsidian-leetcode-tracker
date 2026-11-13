export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export interface ProblemRow {
  frontendId: string;
  slug: string;
  titleCn: string;
  title: string;
  difficulty: Difficulty;
  acRate: number;
  paidOnly: boolean;
  tags: string[];
  tagsCn: string[];
  url: string;
  retired: boolean;
}

export interface RecordRow {
  submissionId: string;
  slug: string;
  status: string;
  lang: string;
  submittedAt: number;
  runtime: string;
  memory: string;
  source: "sync" | "manual";
}

/** 每题从全部提交记录里聚合出的统计，判定状态的唯一数据来源 */
export interface SlugStat {
  lastAcAt: number;
  firstAcAt: number;
  acCount: number;
  lastSubmitAt: number;
  submitCount: number;
}

export interface ResetState {
  /** 全局重置线（unix 秒）；0 表示不重置任何东西 */
  globalBaseline: number;
  /** 单题重置线 */
  perSlugBaseline: Record<string, number>;
  /** 人工强制已刷 */
  manualOn: string[];
  /** 人工强制未刷 */
  manualOff: string[];
}

export const EMPTY_STAT: SlugStat = {
  lastAcAt: 0,
  firstAcAt: 0,
  acCount: 0,
  lastSubmitAt: 0,
  submitCount: 0,
};

/**
 * 力扣 submissionList 返回的是缩写（AC / WA / TLE / MLE / RE / CE / OLE），
 * 只有少数接口返回全称 Accepted。两种形式都必须认，否则所有通过记录都会被
 * 当成"没通过"，表现为「已刷 0」。
 */
export function isAccepted(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s === "accepted" || s === "ac";
}

/** 重置/标记的变更事件类型。文件只追加，永不修改，当前状态由重放得出 */
export type EventKind =
  | "all"
  | "clear_all"
  | "single"
  | "clear_single"
  | "manual_on"
  | "manual_off"
  | "manual_clear";

export interface ResetEvent {
  at: number;
  kind: EventKind;
  slug: string;
}

/** 一轮 = 两次「全部重置」之间（或最近一次重置到现在）的时间窗 */
export interface Round {
  /** 1 起，按时间升序 */
  index: number;
  start: number;
  /** null 表示这一轮还在进行中（是当前轮） */
  end: number | null;
}

export interface RoundStat extends Round {
  isCurrent: boolean;
  /** 该轮完成（本轮通过）的题数，已按付费题设置过滤 */
  count: number;
}

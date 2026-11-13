import type { ResetState } from "./types";

export interface TrackerSettings {
  /** 定时同步间隔（分钟），0 表示关闭定时同步 */
  syncIntervalMinutes: number;
  /** 打开 Obsidian 时自动同步一次 */
  autoSyncOnLoad: boolean;
  /** 原始 cookie 串，形如 "LEETCODE_SESSION=xxx; csrftoken=yyy" */
  cookie: string;
  lastSyncAt: number;
  lastProblemsSyncAt: number;
  /** 列表里是否显示 stale（做过但早于重置线） */
  showStale: boolean;
  /** 列表里是否显示会员题（题库 4498 道里有 790 道需要会员，默认隐藏） */
  showPaid: boolean;
  /** 上次同步写入的游标 */
  cursorSubmissionId: string;
  cursorTimestamp: number;
  /** 已登录账号的显示名（未登录为空串），用来在面板头部展示登录状态 */
  username: string;
  /** 账号头像 URL，拿不到时面板退回用户名首字母 */
  avatarUrl: string;
}

export interface PluginData {
  settings: TrackerSettings;
  reset: ResetState;
}

export const DEFAULT_SETTINGS: TrackerSettings = {
  syncIntervalMinutes: 5,
  autoSyncOnLoad: true,
  cookie: "",
  lastSyncAt: 0,
  lastProblemsSyncAt: 0,
  showStale: true,
  showPaid: false,
  cursorSubmissionId: "",
  cursorTimestamp: 0,
  username: "",
  avatarUrl: "",
};

export const DEFAULT_RESET: ResetState = {
  globalBaseline: 0,
  perSlugBaseline: {},
  manualOn: [],
  manualOff: [],
};

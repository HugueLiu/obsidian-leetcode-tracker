import { requestUrl } from "obsidian";
import type {
  GqlProgressNode,
  GqlProblemNode,
  GqlSubmissionNode,
} from "./queries";
import {
  Q_PROBLEMS,
  Q_SUBMISSIONS,
  Q_USER_PROGRESS,
  Q_USER_STATUS,
} from "./queries";

export type ErrorKind = "network" | "auth" | "rate" | "schema" | "unknown";

export class LcError extends Error {
  constructor(
    message: string,
    public kind: ErrorKind = "unknown",
    public retryable = false
  ) {
    super(message);
    this.name = "LcError";
  }
}

export interface UserStatus {
  isSignedIn: boolean;
  username: string;
  isPremium: boolean;
  /** 头像 URL，未登录时为 null */
  avatar: string | null;
}

/** 已登录账号的最小信息，用来在面板上显示登录状态 */
export interface Account {
  username: string;
  avatar: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

const ENDPOINT = "https://leetcode.cn/graphql/";

/**
 * 力扣 GraphQL 客户端。
 *
 * 三个必须做的事：
 * 1. 用 requestUrl 而不是 fetch —— renderer 里 fetch 打 leetcode.cn 会被 CORS 拦，
 *    requestUrl 走主进程，桌面和移动端都能过。
 * 2. 串行 + 最小间隔 —— 力扣有频率限制，并发打会拿到空响应。
 * 3. 把 GraphQL 的 errors 和 HTTP 错误统一成 LcError，调用方只处理一种错误。
 */
export class LeetCodeClient {
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private minGapMs = 600;

  constructor(private getCookie: () => string) {}

  /** 串行化所有请求，保证不会有两个请求同时在飞 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const gap = Date.now() - this.lastRequestAt;
      if (gap < this.minGapMs) await sleep(this.minGapMs - gap);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next as Promise<T>;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Referer: "https://leetcode.cn/problemset/",
      Origin: "https://leetcode.cn",
    };
    const cookie = this.getCookie().trim();
    if (cookie) {
      h["Cookie"] = cookie;
      const csrf = /csrftoken=([^;]+)/.exec(cookie);
      if (csrf) h["x-csrftoken"] = csrf[1];
    }
    return h;
  }

  async rawQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify({ query, variables });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await requestUrl({
          url: ENDPOINT,
          method: "POST",
          headers: this.headers(),
          body,
          throw: false,
        });

        if (res.status === 403) {
          throw new LcError("力扣拒绝访问（403），可能触发了频率限制或登录态失效", "auth");
        }
        if (res.status === 429) {
          throw new LcError("请求过于频繁（429）", "rate", true);
        }
        if (res.status >= 400) {
          throw new LcError(`HTTP ${res.status}`, "network", res.status >= 500);
        }

        let payload: { data?: T; errors?: { message: string }[] };
        try {
          payload = res.json;
        } catch {
          throw new LcError("响应不是合法 JSON，可能被网关拦截", "network", true);
        }

        if (payload.errors && payload.errors.length) {
          const msg = payload.errors.map((e) => e.message).filter(Boolean).join("; ");
          // 字段不存在 = schema 变了，重试没有意义
          const isSchema = /Cannot query field|Unknown argument|Unknown type/.test(msg);
          throw new LcError(`力扣接口返回错误：${msg || "(无消息)"}`, isSchema ? "schema" : "unknown");
        }
        if (payload.data === undefined) {
          throw new LcError("力扣接口没有返回 data", "unknown");
        }
        return payload.data;
      } catch (e) {
        const err = e instanceof LcError ? e : new LcError(String(e), "network", true);
        if (err.retryable && attempt < 2) {
          await sleep(1200 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
    throw new LcError("请求重试次数耗尽", "network");
  }

  async userStatus(): Promise<UserStatus> {
    const d = await this.rawQuery<{ userStatus: UserStatus }>(Q_USER_STATUS);
    return d.userStatus;
  }

  /** 断言已登录。未登录时 submissionList 会静默返回空数组，绝不能靠"有数据"判断。 */
  async assertSignedIn(): Promise<Account> {
    const st = await this.userStatus();
    if (!st.isSignedIn) {
      throw new LcError(
        "未登录或登录态已过期。请点「登录」重新获取，或在设置里粘贴力扣 cookie。",
        "auth"
      );
    }
    return { username: st.username || "", avatar: st.avatar || "" };
  }

  async problemsPage(
    skip: number,
    limit: number
  ): Promise<{ total: number; hasMore: boolean; questions: GqlProblemNode[] }> {
    const d = await this.rawQuery<{
      problemsetQuestionList: { total: number; hasMore: boolean; questions: GqlProblemNode[] };
    }>(Q_PROBLEMS, { limit, skip, filters: {} });
    return d.problemsetQuestionList;
  }

  async submissionsPage(
    offset: number,
    limit: number,
    questionSlug?: string
  ): Promise<{ hasNext: boolean; submissions: GqlSubmissionNode[] }> {
    const d = await this.rawQuery<{
      submissionList: { hasNext: boolean; submissions: GqlSubmissionNode[] };
    }>(Q_SUBMISSIONS, { offset, limit, questionSlug: questionSlug ?? null });
    return d.submissionList;
  }

  async userProgress(): Promise<{ totalNum: number; questions: GqlProgressNode[] }> {
    const d = await this.rawQuery<{
      userProgressQuestionList: { totalNum: number; questions: GqlProgressNode[] } | null;
    }>(Q_USER_PROGRESS);
    if (!d.userProgressQuestionList) {
      throw new LcError("未登录，无法读取做题进度", "auth");
    }
    return d.userProgressQuestionList;
  }
}

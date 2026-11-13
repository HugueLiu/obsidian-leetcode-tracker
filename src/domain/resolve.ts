import type { ProblemStore } from "../store/problems";
import type { GqlSubmissionNode } from "../api/queries";
import { normalizeTitle } from "./normalize";

export interface ResolveResult {
  slug: string | null;
  /** 哪一级规则命中，便于排查 */
  via: "url" | "title" | "fuzzy" | "none";
}

/**
 * 把一条提交映射到题目 slug。
 *
 * 背景：力扣的 SubmissionDumpNode 实测**没有 titleSlug** 字段（只有 title / url），
 * 所以归属必须自己算。三级降级，任何一级命中就返回。
 *
 * 全失败时返回 null，由调用方收进「待确认」队列 —— 绝不允许静默丢弃事件，
 * 丢了就是账对不上，而且用户查不出原因。
 */
export function resolveSlug(
  node: Pick<GqlSubmissionNode, "title" | "url">,
  problems: ProblemStore
): ResolveResult {
  // 1. url 里的 slug 路径（最可靠）
  const rawUrl = node.url || "";
  const m = /\/problems\/([^/?#]+)/.exec(rawUrl);
  if (m) {
    const candidate = decodeURIComponent(m[1]);
    // 中文站的 url 可能是中文题名路径，只有形如 slug 且题库里存在才算命中
    if (/^[a-z0-9-]+$/.test(candidate) && problems.get(candidate)) {
      return { slug: candidate, via: "url" };
    }
  }

  const title = node.title || "";
  if (!title) return { slug: null, via: "none" };

  // 2. 标题精确匹配（中/英）
  const exact = problems.byTitleLookup(title);
  if (exact) return { slug: exact, via: "title" };

  // 3. 规范化后匹配（走预建索引，O(1)，不遍历题库）
  const hit = problems.byNormLookup(normalizeTitle(title));
  if (hit) return { slug: hit, via: "fuzzy" };

  return { slug: null, via: "none" };
}

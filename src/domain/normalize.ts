/** 规范化用于模糊匹配：去空格、去标点、转小写 */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\-_.,'"!?:;()（）《》【】·、，。！？：；]/g, "")
    .trim();
}

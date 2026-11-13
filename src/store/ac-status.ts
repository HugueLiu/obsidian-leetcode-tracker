import type { DataAdapter } from "obsidian";
import { parseCsv, csvLine } from "./csv";
import { AC_SLUGS_CSV } from "./paths";

/**
 * "力扣认为这题 AC 过"的快照。
 *
 * 为什么单独存：submissionList 的 offset 硬上限是 2000（实测 offset=2000 直接返回空），
 * 早期提交注定拿不到，光看提交记录会把"2020 年 AC 过、但记录已滑出窗口"的题判成未刷。
 * problemsetQuestionList 的 status 字段是逐题状态，不受这个上限影响，可以补全。
 */
export class AcStatusStore {
  private slugs = new Set<string>();

  get size(): number {
    return this.slugs.size;
  }

  has(slug: string): boolean {
    return this.slugs.has(slug);
  }

  asSet(): Set<string> {
    return this.slugs;
  }

  /** 按 slug 字典序，逐题补全时顺序稳定、便于中间续跑 */
  list(): string[] {
    return [...this.slugs].sort();
  }

  async load(adapter: DataAdapter): Promise<void> {
    this.slugs.clear();
    if (!(await adapter.exists(AC_SLUGS_CSV))) return;
    const { rows } = parseCsv(await adapter.read(AC_SLUGS_CSV));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0]) continue;
      // 跳过表头
      if (i === 0 && r[0].trim() === "slug") continue;
      this.slugs.add(r[0]);
    }
  }

  async save(adapter: DataAdapter, slugs: string[]): Promise<void> {
    const lines = ["slug", ...slugs.map((s) => csvLine([s]))];
    await adapter.write(AC_SLUGS_CSV, lines.join("\n") + "\n");
    this.slugs = new Set(slugs);
  }
}

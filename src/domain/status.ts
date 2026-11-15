import type { ResetState, SlugStat } from "../types";

export type Status = "done" | "notDone" | "stale";

/**
 * 状态判定，全插件唯一的判定入口。
 *
 *   ① 人工强制未刷        → notDone
 *   ② 人工强制已刷        → done
 *   ③ 最近 AC 晚于重置线  → done
 *   ④ 有 AC 但早于重置线  → stale（做过，但不算数）
 *   ⑤ 从未 AC             → notDone
 *
 * 优先级不可颠倒：人的意志必须压过自动同步。
 */
export class StatusResolver {
  private on = new Set<string>();
  private off = new Set<string>();
  private globalBaseline = 0;
  private perSlug: Record<string, number> = {};
  /** 力扣侧确认 AC 过的题（含提交记录已滑出 2000 条窗口的） */
  private acKnown = new Set<string>();

  constructor(reset?: ResetState) {
    if (reset) this.apply(reset);
  }

  apply(reset: ResetState): void {
    this.on = new Set(reset.manualOn);
    this.off = new Set(reset.manualOff);
    this.globalBaseline = reset.globalBaseline;
    this.perSlug = reset.perSlugBaseline;
  }

  /** 由 AcStatusStore 灌入：这些题在力扣侧确实 AC 过 */
  setAcKnown(slugs: Set<string>): void {
    this.acKnown = slugs;
  }

  /** 单题有效重置线 = max(单题线, 全局线)。取最大值，永远只认最新抬高的那条。 */
  baseline(slug: string): number {
    const per = this.perSlug[slug];
    if (per === undefined) return this.globalBaseline;
    return Math.max(per, this.globalBaseline);
  }

  status(slug: string, stat: SlugStat): Status {
    if (this.off.has(slug)) return "notDone";
    if (this.on.has(slug)) return "done";
    if (stat.lastAcAt > 0) {
      return stat.lastAcAt > this.baseline(slug) ? "done" : "stale";
    }
    // 本地没有 AC 时间戳，但力扣确认这题 AC 过 —— 说明那次通过发生在
    // 提交记录窗口（最近 2000 条）之外。设过重置线就无法确认先后，按「以前做过」算，
    // 用户可在右键里手动标记为已刷；没设过重置线则一律算已刷。
    if (this.acKnown.has(slug)) {
      return this.baseline(slug) > 0 ? "stale" : "done";
    }
    return "notDone";
  }

  isDone(slug: string, stat: SlugStat): boolean {
    return this.status(slug, stat) === "done";
  }

  /**
   * 累计口径：不看重置线，历史上 AC 过就算"曾经刷过"。
   * 用来和"本轮已刷"对照 —— 两者之差就是被重置线排除掉的旧成绩。
   * 注意这里也刻意不看 manualOn / manualOff：累计是客观事实，人工标记只影响本轮。
   */
  everDone(slug: string, stat: SlugStat): boolean {
    return stat.lastAcAt > 0 || this.acKnown.has(slug);
  }
}

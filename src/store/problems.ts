import type { DataAdapter } from "obsidian";
import { csvLine, parseCsv, joinMulti, splitMulti } from "./csv";
import { DATA_DIR, PROBLEMS_CSV, PROBLEMS_HEADER, problemUrl } from "./paths";
import { normalizeTitle } from "../domain/normalize";
import type { Difficulty, ProblemRow } from "../types";

/**
 * 题库快照。4000 行左右，全量驻留内存，读取一次即可。
 * 只在"刷新题库"时整体重写，日常只读。
 */
export class ProblemStore {
  private map = new Map<string, ProblemRow>();
  private byTitle = new Map<string, string>();
  private byTitleCn = new Map<string, string>();
  private byFrontendId = new Map<string, string>();
  /** 规范化标题索引，供提交归属的模糊匹配用，避免遍历 4000 题 */
  private byNorm = new Map<string, string>();
  loaded = false;

  get size(): number {
    return this.map.size;
  }

  async load(adapter: DataAdapter): Promise<void> {
    this.map.clear();
    this.byTitle.clear();
    this.byTitleCn.clear();
    this.byFrontendId.clear();
    this.byNorm.clear();
    this.loaded = true;

    if (!(await adapter.exists(PROBLEMS_CSV))) return;
    const text = await adapter.read(PROBLEMS_CSV);
    const { rows } = parseCsv(text);
    if (rows.length <= 1) return;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length < PROBLEMS_HEADER.length) continue;
      const row: ProblemRow = {
        frontendId: r[0],
        slug: r[1],
        titleCn: r[2],
        title: r[3],
        difficulty: r[4] as Difficulty,
        acRate: Number(r[5]) || 0,
        paidOnly: r[6] === "1",
        tags: splitMulti(r[7]),
        tagsCn: splitMulti(r[8]),
        url: r[9] || problemUrl(r[1]),
        retired: r[10] === "1",
      };
      this.index(row);
    }
  }

  private index(row: ProblemRow): void {
    this.map.set(row.slug, row);
    if (row.title) this.byTitle.set(row.title, row.slug);
    if (row.titleCn) this.byTitleCn.set(row.titleCn, row.slug);
    if (row.frontendId) this.byFrontendId.set(row.frontendId, row.slug);
    if (row.title) this.byNorm.set(normalizeTitle(row.title), row.slug);
    if (row.titleCn) this.byNorm.set(normalizeTitle(row.titleCn), row.slug);
  }

  async save(adapter: DataAdapter): Promise<void> {
    if (!(await adapter.exists(DATA_DIR))) {
      await adapter.mkdir(DATA_DIR);
    }
    const lines: string[] = [csvLine(PROBLEMS_HEADER)];
    for (const row of this.map.values()) {
      lines.push(
        csvLine([
          row.frontendId,
          row.slug,
          row.titleCn,
          row.title,
          row.difficulty,
          row.acRate,
          row.paidOnly ? 1 : 0,
          joinMulti(row.tags),
          joinMulti(row.tagsCn),
          row.url,
          row.retired ? 1 : 0,
        ])
      );
    }
    await adapter.write(PROBLEMS_CSV, lines.join(""));
  }

  /** 覆盖式写入一批题目（全量刷新时用），返回新增数 */
  replaceAll(rows: ProblemRow[]): number {
    const before = this.map.size;
    this.map.clear();
    this.byTitle.clear();
    this.byTitleCn.clear();
    this.byFrontendId.clear();
    this.byNorm.clear();
    for (const row of rows) this.index(row);
    return Math.max(0, this.map.size - before);
  }

  get(slug: string): ProblemRow | undefined {
    return this.map.get(slug);
  }

  byTitleLookup(title: string): string | undefined {
    return this.byTitle.get(title) || this.byTitleCn.get(title);
  }

  byNormLookup(normalized: string): string | undefined {
    if (!normalized) return undefined;
    return this.byNorm.get(normalized);
  }

  byIdLookup(id: string): string | undefined {
    return this.byFrontendId.get(id);
  }

  all(): ProblemRow[] {
    return Array.from(this.map.values());
  }

  /** 提取全部标签（slug + 中文名），用于筛选下拉 */
  allTags(): { slug: string; name: string }[] {
    const out = new Map<string, string>();
    for (const p of this.map.values()) {
      for (let i = 0; i < p.tags.length; i++) {
        if (!out.has(p.tags[i])) out.set(p.tags[i], p.tagsCn[i] || p.tags[i]);
      }
    }
    return Array.from(out.entries())
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }
}

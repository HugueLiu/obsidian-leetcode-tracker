import type { DataAdapter } from "obsidian";
import { csvLine, parseCsv } from "./csv";
import { DATA_DIR, RECORDS_CSV, RECORDS_HEADER } from "./paths";
import { EMPTY_STAT, isAccepted } from "../types";
import type { RecordRow, SlugStat } from "../types";

/**
 * 提交记录，append-only。
 * 写入：只在文件末尾追加一行（约 100 字节），从不重写。
 * 读取：启动时一次性扫入内存，建 slug -> 聚合统计 的索引。
 */
export class RecordStore {
  private index = new Map<string, SlugStat>();
  /** 每题的每一次 Accepted 时间戳，用于按轮次的时间窗回溯 */
  private acTimes = new Map<string, number[]>();
  private seen = new Set<string>();
  /** 最近若干条提交，仅用于 UI，不参与判定 */
  private recent: RecordRow[] = [];
  private headerWritten = false;
  /** 上次写入中断导致文件末尾缺换行，下次追加前要先补 */
  private needsLeadingNewline = false;
  private totalRows = 0;

  get count(): number {
    return this.totalRows;
  }

  /** 本地出现过的全部题目 slug，用于逐题全量对齐 */
  allSlugs(): string[] {
    return [...this.index.keys()];
  }

  async load(adapter: DataAdapter): Promise<void> {
    this.index.clear();
    this.acTimes.clear();
    this.seen.clear();
    this.recent = [];
    this.totalRows = 0;

    if (!(await adapter.exists(RECORDS_CSV))) {
      this.headerWritten = false;
      this.needsLeadingNewline = false;
      return;
    }
    const text = await adapter.read(RECORDS_CSV);
    const { rows, endedWithNewline } = parseCsv(text);
    this.needsLeadingNewline = text.length > 0 && !endedWithNewline;
    if (rows.length === 0) {
      this.headerWritten = false;
      return;
    }

    // 第一行是表头
    let start = 1;
    if (!rows[0][0] || rows[0][0].trim() === "submission_id") {
      this.headerWritten = true;
      start = 1;
    } else {
      // 没有表头的旧文件
      start = 0;
      this.headerWritten = false;
    }

    const lastIdx = rows.length - 1;
    for (let i = start; i <= lastIdx; i++) {
      const r = rows[i];
      // 末行在"没有换行结尾"时可能被截断，字段数不足则丢弃
      if (i === lastIdx && !endedWithNewline && r.length < RECORDS_HEADER.length) continue;
      if (r.length < RECORDS_HEADER.length) continue;
      const row: RecordRow = {
        submissionId: r[0],
        slug: r[1],
        status: r[2],
        lang: r[3],
        submittedAt: Number(r[4]) || 0,
        runtime: r[5],
        memory: r[6],
        source: (r[7] as RecordRow["source"]) || "sync",
      };
      this.applyToIndex(row);
      this.totalRows += 1;
    }
  }

  private applyToIndex(row: RecordRow): void {
    if (this.seen.has(row.submissionId)) return;
    this.seen.add(row.submissionId);

    const st = this.index.get(row.slug) ?? { ...EMPTY_STAT };
    st.submitCount += 1;
    if (row.submittedAt > st.lastSubmitAt) st.lastSubmitAt = row.submittedAt;

    if (isAccepted(row.status)) {
      st.acCount += 1;
      if (st.firstAcAt === 0 || row.submittedAt < st.firstAcAt) st.firstAcAt = row.submittedAt;
      if (row.submittedAt > st.lastAcAt) st.lastAcAt = row.submittedAt;

      const arr = this.acTimes.get(row.slug);
      if (arr) arr.push(row.submittedAt);
      else this.acTimes.set(row.slug, [row.submittedAt]);
    }
    this.index.set(row.slug, st);

    this.recent.unshift(row);
    if (this.recent.length > 300) this.recent.length = 300;
  }

  /** 追加一批记录，返回真正写入的条数（已存在 submissionId 的会被跳过） */
  async appendRows(adapter: DataAdapter, rows: RecordRow[]): Promise<number> {
    const fresh = rows.filter((r) => r.submissionId && !this.seen.has(r.submissionId));
    if (fresh.length === 0) return 0;

    if (!(await adapter.exists(DATA_DIR))) {
      await adapter.mkdir(DATA_DIR);
    }

    const body = fresh
      .map((r) =>
        csvLine([
          r.submissionId,
          r.slug,
          r.status,
          r.lang,
          r.submittedAt,
          r.runtime,
          r.memory,
          r.source,
        ])
      )
      .join("");

    const fileExists = await adapter.exists(RECORDS_CSV);

    if (!fileExists) {
      // 首次建文件：表头 + 正文
      await adapter.write(RECORDS_CSV, csvLine(RECORDS_HEADER) + body);
    } else if (!this.headerWritten) {
      // 文件存在但缺表头（历史遗留），补表头后整体重写，避免表头落到中间
      const old = await adapter.read(RECORDS_CSV);
      await adapter.write(RECORDS_CSV, csvLine(RECORDS_HEADER) + old + body);
    } else {
      // 上次写入中断会让文件末尾缺换行，此时先补一个，否则新行会粘到旧行上
      const pad = this.needsLeadingNewline ? "\n" : "";
      await adapter.append(RECORDS_CSV, pad + body);
    }

    this.headerWritten = true;
    this.needsLeadingNewline = false;

    for (const r of fresh) {
      this.applyToIndex(r);
      this.totalRows += 1;
    }
    return fresh.length;
  }

  stat(slug: string): SlugStat {
    return this.index.get(slug) ?? EMPTY_STAT;
  }

  /** 某题在 [start, end) 时间窗内是否有通过记录；end 传 Infinity 表示直到现在 */
  hasAcInRange(slug: string, start: number, end: number): boolean {
    const arr = this.acTimes.get(slug);
    if (!arr) return false;
    for (const t of arr) {
      if (t >= start && t < end) return true;
    }
    return false;
  }

  hasSubmission(id: string): boolean {
    return this.seen.has(id);
  }

  recentRows(limit = 30): RecordRow[] {
    return this.recent.slice(0, limit);
  }

  /**
   * 全部记录，按提交时间倒序。专给"提交记录页"用：
   * 一次性扫文件换取完整数据，不把几千条常驻内存。
   */
  async allRows(adapter: DataAdapter): Promise<RecordRow[]> {
    if (!(await adapter.exists(RECORDS_CSV))) return [];
    const text = await adapter.read(RECORDS_CSV);
    const { rows, endedWithNewline } = parseCsv(text);
    if (rows.length === 0) return [];

    const start = !rows[0][0] || rows[0][0].trim() === "submission_id" ? 1 : 0;
    const lastIdx = rows.length - 1;
    const seen = new Set<string>();
    const out: RecordRow[] = [];

    for (let i = start; i <= lastIdx; i++) {
      const r = rows[i];
      if (i === lastIdx && !endedWithNewline && r.length < RECORDS_HEADER.length) continue;
      if (r.length < RECORDS_HEADER.length) continue;
      if (seen.has(r[0])) continue;
      seen.add(r[0]);
      out.push({
        submissionId: r[0],
        slug: r[1],
        status: r[2],
        lang: r[3],
        submittedAt: Number(r[4]) || 0,
        runtime: r[5],
        memory: r[6],
        source: (r[7] as RecordRow["source"]) || "sync",
      });
    }
    out.sort((a, b) => b.submittedAt - a.submittedAt);
    return out;
  }

  /** 某题的全部历史（按需扫文件，不在内存常驻） */
  async historyFor(adapter: DataAdapter, slug: string): Promise<RecordRow[]> {
    if (!(await adapter.exists(RECORDS_CSV))) return [];
    const text = await adapter.read(RECORDS_CSV);
    const { rows } = parseCsv(text);
    const out: RecordRow[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length < RECORDS_HEADER.length) continue;
      if (r[1] !== slug) continue;
      out.push({
        submissionId: r[0],
        slug: r[1],
        status: r[2],
        lang: r[3],
        submittedAt: Number(r[4]) || 0,
        runtime: r[5],
        memory: r[6],
        source: (r[7] as RecordRow["source"]) || "sync",
      });
    }
    return out.sort((a, b) => b.submittedAt - a.submittedAt);
  }
}

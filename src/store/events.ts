import type { DataAdapter } from "obsidian";
import { csvLine, parseCsv } from "./csv";
import { DATA_DIR, EVENTS_CSV, EVENTS_HEADER } from "./paths";
import type { EventKind, ResetEvent, Round } from "../types";

const VALID_KINDS = new Set<string>([
  "all",
  "clear_all",
  "single",
  "clear_single",
  "manual_on",
  "manual_off",
  "manual_clear",
]);

/**
 * 重置 / 人工标记的变更日志。
 *
 * 为什么不存"轮次"本身：轮次是时间窗，由「全部重置」事件切出来，属于派生数据。
 * 只追加事件、启动时重放，就能同时得到当前基线（现有 StatusResolver 的行为）
 * 和每一轮边界，任何一步都不需要修改历史行。
 */
export class EventStore {
  private events: ResetEvent[] = [];
  private headerWritten = false;
  private needsLeadingNewline = false;
  private totalRows = 0;

  get all(): readonly ResetEvent[] {
    return this.events;
  }

  get count(): number {
    return this.totalRows;
  }

  async load(adapter: DataAdapter): Promise<void> {
    this.events = [];
    this.totalRows = 0;
    this.headerWritten = false;
    this.needsLeadingNewline = false;

    if (!(await adapter.exists(EVENTS_CSV))) return;
    const text = await adapter.read(EVENTS_CSV);
    if (!text) return;

    const { rows, endedWithNewline } = parseCsv(text);
    this.needsLeadingNewline = !endedWithNewline;
    if (rows.length === 0) return;

    let start = 0;
    if (rows[0][0] === "at") {
      this.headerWritten = true;
      start = 1;
    }

    const lastIdx = rows.length - 1;
    for (let i = start; i <= lastIdx; i++) {
      const r = rows[i];
      // 上次写入中断会在末尾留下半行，字段不足则丢弃
      if (i === lastIdx && !endedWithNewline && r.length < EVENTS_HEADER.length) continue;
      if (r.length < EVENTS_HEADER.length) continue;
      const at = Number(r[0]) || 0;
      const kind = r[1] as EventKind;
      if (!at || !VALID_KINDS.has(kind)) continue;
      this.events.push({ at, kind, slug: r[2] || "" });
      this.totalRows += 1;
    }

    // 稳定排序：同一秒的事件保持文件里的先后顺序
    this.events.sort((a, b) => a.at - b.at);
  }

  async append(adapter: DataAdapter, ev: ResetEvent): Promise<void> {
    await this.appendMany(adapter, [ev]);
  }

  async appendMany(adapter: DataAdapter, evs: ResetEvent[]): Promise<void> {
    if (evs.length === 0) return;
    if (!(await adapter.exists(DATA_DIR))) await adapter.mkdir(DATA_DIR);

    const body = evs.map((e) => csvLine([e.at, e.kind, e.slug])).join("");
    const fileExists = await adapter.exists(EVENTS_CSV);

    if (!fileExists) {
      await adapter.write(EVENTS_CSV, csvLine(EVENTS_HEADER) + body);
    } else if (!this.headerWritten) {
      const old = await adapter.read(EVENTS_CSV);
      await adapter.write(EVENTS_CSV, csvLine(EVENTS_HEADER) + old + body);
    } else {
      const pad = this.needsLeadingNewline ? "\n" : "";
      await adapter.append(EVENTS_CSV, pad + body);
    }

    this.headerWritten = true;
    this.needsLeadingNewline = false;

    for (const e of evs) {
      this.events.push(e);
      this.totalRows += 1;
    }
    this.events.sort((a, b) => a.at - b.at);
  }

  /**
   * 重放出轮次列表。
   * - 每个 `all`（全部重置）开启一轮
   * - 下一个 `all` 或 `clear_all`（撤销全部重置）关闭当前轮
   * - 单题重置不切轮，只影响该题在当前轮的判定（由 StatusResolver 负责）
   */
  buildRounds(): Round[] {
    const rounds: Round[] = [];
    let cur: Round | null = null;

    for (const e of this.events) {
      if (e.kind === "all") {
        if (cur) {
          cur.end = e.at;
          cur = null;
        }
        cur = { index: 0, start: e.at, end: null };
        rounds.push(cur);
      } else if (e.kind === "clear_all") {
        if (cur) {
          cur.end = e.at;
          cur = null;
        }
      }
    }

    rounds.forEach((r, i) => {
      r.index = i + 1;
    });
    return rounds;
  }

  /** 当前进行中的那一轮，没有则为 null */
  currentRound(): Round | null {
    const rounds = this.buildRounds();
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i].end === null) return rounds[i];
    }
    return null;
  }
}

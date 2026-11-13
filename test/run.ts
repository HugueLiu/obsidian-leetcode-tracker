import { FsAdapter } from "./fs-adapter";
import { csvLine, parseCsv, splitMulti, joinMulti } from "../src/store/csv";
import { ProblemStore } from "../src/store/problems";
import { RecordStore } from "../src/store/records";
import { EventStore } from "../src/store/events";
import { StatusResolver } from "../src/domain/status";
import { resolveSlug } from "../src/domain/resolve";
import { DEFAULT_RESET } from "../src/state";
import { RECORDS_HEADER } from "../src/store/paths";
import type { ProblemRow, RecordRow, ResetState } from "../src/types";
import { EMPTY_STAT, isAccepted } from "../src/types";

let passed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n▸ ${name}`);
}

function ts(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}

const T2021 = ts(2021, 3, 1);
const T2024 = ts(2024, 6, 10);
const T2026 = ts(2026, 11, 10);

function mkProblem(id: string, slug: string, cn: string, en: string, diff: ProblemRow["difficulty"], tags: string[], tagsCn: string[]): ProblemRow {
  return {
    frontendId: id,
    slug,
    titleCn: cn,
    title: en,
    difficulty: diff,
    acRate: 0.5,
    paidOnly: false,
    tags,
    tagsCn,
    url: `https://leetcode.cn/problems/${slug}/`,
    retired: false,
  };
}

function mkRecord(id: string, slug: string, status: string, at: number, lang = "cpp"): RecordRow {
  return { submissionId: id, slug, status, lang, submittedAt: at, runtime: "", memory: "", source: "sync" };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- CSV
  section("CSV 解析");

  const tricky = [
    ["id", "title", "note"],
    ["1", "Two Sum, II", 'he said "hi"'],
    ["2", "两数之和（含逗号，中文）", "line1\nline2"],
    ["3", "", ""],
  ];
  const encoded = tricky.map((r) => csvLine(r)).join("");
  const roundTrip = parseCsv(encoded);
  assert(roundTrip.rows.length === 4, `round-trip 行数应为 4，实际 ${roundTrip.rows.length}`);
  assert(roundTrip.rows[1][1] === "Two Sum, II", "含逗号的字段应被正确还原");
  assert(roundTrip.rows[1][2] === 'he said "hi"', "含双引号的字段应被正确还原");
  assert(roundTrip.rows[2][1] === "两数之和（含逗号，中文）", "中文+逗号字段应被正确还原");
  assert(roundTrip.rows[2][2] === "line1\nline2", "含换行的字段应被正确还原");
  assert(roundTrip.endedWithNewline === true, "正常文件应以换行结尾");

  const truncated = parseCsv('a,b,c\n1,2');
  // 截断行仍会进 rows，靠 endedWithNewline 让调用方决定丢弃 —— 这是有意的分工
  assert(truncated.rows.length === 2, "截断行会被解析出来，但会带上未结尾标记");
  assert(truncated.endedWithNewline === false, "截断文件应被识别为无换行结尾");

  assert(splitMulti("array|hash-table").length === 2, "多值列拆分");
  assert(joinMulti(["a", "b"]) === "a|b", "多值列拼接");

  // ---------------------------------------------------------------- 题库
  section("题库存储与索引");

  const adapter = new FsAdapter();
  const problems = new ProblemStore();
  const rows: ProblemRow[] = [
    mkProblem("1", "two-sum", "两数之和", "Two Sum", "EASY", ["array", "hash-table"], ["数组", "哈希表"]),
    mkProblem("42", "trapping-rain-water", "接雨水", "Trapping Rain Water", "HARD", ["stack"], ["栈"]),
    mkProblem("53", "maximum-subarray", "最大子数组和", "Maximum Subarray", "MEDIUM", ["dp"], ["动态规划"]),
  ];
  problems.replaceAll(rows);
  await problems.save(adapter as never);

  const problems2 = new ProblemStore();
  await problems2.load(adapter as never);
  assert(problems2.size === 3, `重新加载后应有 3 道题，实际 ${problems2.size}`);
  assert(problems2.get("two-sum")?.titleCn === "两数之和", "中文标题应正确持久化");
  assert(problems2.allTags().length === 4, `标签数应为 4，实际 ${problems2.allTags().length}`);

  // ---------------------------------------------------------------- 记录
  section("提交记录：追加、去重、聚合");

  // 力扣 submissionList 实际返回的是缩写 AC 而不是 Accepted。
  // 早期只认 Accepted → 所有通过记录都被当成没通过 → 面板永远「已刷 0」。
  assert(isAccepted("AC"), "缩写 AC 必须算通过");
  assert(isAccepted("Accepted"), "全称 Accepted 必须算通过");
  assert(isAccepted("accepted"), "小写 accepted 必须算通过");
  assert(isAccepted(" WA ") === false, "WA 不算通过");
  assert(isAccepted("TLE") === false, "TLE 不算通过");
  assert(isAccepted("") === false, "空状态不算通过");

  const records = new RecordStore();
  await records.load(adapter as never);

  // two-sum：2021 一次 AC + 一次 WA
  const batch1: RecordRow[] = [
    mkRecord("s1", "two-sum", "Accepted", T2021),
    mkRecord("s2", "two-sum", "Wrong Answer", T2021 + 100),
  ];
  const w1 = await records.appendRows(adapter as never, batch1);
  assert(w1 === 2, `首次应写入 2 条，实际 ${w1}`);
  assert(records.stat("two-sum").lastAcAt === T2021, "lastAcAt 应等于 2021 那次 AC");
  assert(records.stat("two-sum").submitCount === 2, "submitCount 应为 2");

  // 幂等：重复提交同一批
  const w2 = await records.appendRows(adapter as never, batch1);
  assert(w2 === 0, `重复写入应为 0 条，实际 ${w2}`);
  assert(records.stat("two-sum").submitCount === 2, "去重后 submitCount 仍应为 2");

  // 重启后不丢
  const records2 = new RecordStore();
  await records2.load(adapter as never);
  assert(records2.count === 2, `重新加载后应有 2 条记录，实际 ${records2.count}`);
  assert(records2.stat("two-sum").lastAcAt === T2021, "重启后 lastAcAt 仍应正确");
  assert(records2.hasSubmission("s1"), "重启后 submissionId 去重集合应恢复");

  // 提交记录页的数据源：全量 + 按时间倒序
  const allRows = await records2.allRows(adapter as never);
  assert(allRows.length === 2, `allRows 应返回 2 条，实际 ${allRows.length}`);
  assert(
    allRows[0].submittedAt >= allRows[1].submittedAt,
    "allRows 必须按提交时间倒序（最新的在最上面）"
  );

  // ---------------------------------------------------------------- 中断自愈
  section("写入中断后的自愈");

  const truncAdapter = new FsAdapter();
  const goodLine = csvLine(["s1", "two-sum", "Accepted", "cpp", T2021, "", "", "sync"]);
  // 模拟上一次 append 写到一半断电：文件末尾是一条缺字段、且没有换行结尾的记录
  await truncAdapter.write(
    ".leetcode/records.csv",
    csvLine(RECORDS_HEADER) + goodLine + "s2,two-sum,Acc"
  );

  const truncStore = new RecordStore();
  await truncStore.load(truncAdapter as never);
  assert(truncStore.count === 1, `截断行应被丢弃，应为 1 条，实际 ${truncStore.count}`);
  assert(truncStore.hasSubmission("s1"), "完整记录不应受影响");

  // 继续追加：必须能自愈，不能把新行粘到那条残行上
  const healed = await truncStore.appendRows(truncAdapter as never, [
    mkRecord("s3", "two-sum", "Accepted", T2026),
  ]);
  assert(healed === 1, `自愈后应写入 1 条，实际 ${healed}`);

  const verify = new RecordStore();
  await verify.load(truncAdapter as never);
  assert(verify.count === 2, `自愈后重载应为 2 条，实际 ${verify.count}`);
  assert(verify.hasSubmission("s3"), "新记录应能正常读回（说明已补上换行）");

  // ---------------------------------------------------------------- 判定
  section("状态判定：四层优先级");

  const reset: ResetState = Object.assign({}, DEFAULT_RESET);
  const resolver = new StatusResolver(reset);

  assert(resolver.status("two-sum", records2.stat("two-sum")) === "done", "无重置线时，2021 的 AC 应算已刷");
  assert(resolver.status("trapping-rain-water", records2.stat("trapping-rain-water")) === "notDone", "从未 AC 应为未刷");

  // 单题重置
  const now = T2026;
  reset.perSlugBaseline["two-sum"] = now;
  resolver.apply(reset);
  assert(resolver.status("two-sum", records2.stat("two-sum")) === "stale", "重置后旧 AC 应降级为「仅历史」");
  assert(resolver.isDone("two-sum", records2.stat("two-sum")) === false, "重置后 isDone 必须为 false");

  // 重置后再做一遍 → 自动翻回已刷
  await records2.appendRows(adapter as never, [mkRecord("s9", "two-sum", "Accepted", T2026 + 3600)]);
  assert(resolver.status("two-sum", records2.stat("two-sum")) === "done", "重置后又 AC 过，应自动变回已刷");

  // 人工强制未刷压过一切
  reset.manualOff = ["maximum-subarray"];
  reset.manualOn = ["trapping-rain-water"];
  resolver.apply(reset);
  await records2.appendRows(adapter as never, [mkRecord("s10", "maximum-subarray", "Accepted", T2026 + 7200)]);
  assert(resolver.status("maximum-subarray", records2.stat("maximum-subarray")) === "notDone", "manual_off 应压过新 AC");
  assert(resolver.status("trapping-rain-water", records2.stat("trapping-rain-water")) === "done", "manual_on 应直接判已刷");

  // baseline 取 max
  reset.manualOff = [];
  reset.manualOn = [];
  reset.perSlugBaseline = { "two-sum": T2021 };
  reset.globalBaseline = T2026;
  resolver.apply(reset);
  // two-sum 的有效线应为 T2026（取较大），2026 之后的 AC 才算
  assert(resolver.baseline("two-sum") === T2026, "单题线早于全局线时，应取全局线");

  // 力扣状态补全：提交记录滑出 2000 条窗口的题，本地没有 AC 时间戳
  const fresh = new StatusResolver(Object.assign({}, DEFAULT_RESET));
  fresh.setAcKnown(new Set(["an-old-ac"]));
  assert(
    fresh.status("an-old-ac", EMPTY_STAT) === "done",
    "无重置线时，力扣确认 AC 过（即使本地无时间戳）必须算已刷"
  );
  assert(fresh.status("never-touched", EMPTY_STAT) === "notDone", "缺省题仍应为未刷");

  const gated = new StatusResolver(Object.assign({}, DEFAULT_RESET, { globalBaseline: T2026 }));
  gated.setAcKnown(new Set(["an-old-ac"]));
  assert(
    gated.status("an-old-ac", EMPTY_STAT) === "stale",
    "有重置线且无时间戳时无法确认先后，按「仅历史」而非已刷"
  );
  assert(
    gated.status("an-old-ac", { ...EMPTY_STAT, lastAcAt: T2026 + 100 }) === "done",
    "有本地时间戳时仍以时间戳为准"
  );

  // ---------------------------------------------------------------- 归属
  section("提交 → 题目映射");

  const r1 = resolveSlug({ title: "两数之和", url: "/problems/two-sum/" }, problems2);
  assert(r1.slug === "two-sum" && r1.via === "url", `url 解析应命中 two-sum，实际 ${JSON.stringify(r1)}`);

  const r2 = resolveSlug({ title: "接雨水", url: "/problems/接雨水/" }, problems2);
  assert(r2.slug === "trapping-rain-water" && r2.via === "title", `中文标题路径应回落到标题匹配，实际 ${JSON.stringify(r2)}`);

  const r3 = resolveSlug({ title: "maximum   subarray", url: "" }, problems2);
  assert(r3.slug === "maximum-subarray" && r3.via === "fuzzy", `规范化匹配应命中，实际 ${JSON.stringify(r3)}`);

  const r4 = resolveSlug({ title: "完全不存在的题目", url: "/problems/unknown-xyz/" }, problems2);
  assert(r4.slug === null, "无法匹配时应返回 null，而不是瞎猜");

  // ---------------------------------------------------------------- 规模
  section("规模压测：4498 题 / 20000 条提交");

  const bigAdapter = new FsAdapter();
  const bigProblems = new ProblemStore();
  const bigRows: ProblemRow[] = [];
  for (let i = 1; i <= 4498; i++) {
    bigRows.push(
      mkProblem(
        String(i),
        `problem-${i}`,
        `题目${i}`,
        `Problem ${i}`,
        i % 3 === 0 ? "HARD" : i % 3 === 1 ? "EASY" : "MEDIUM",
        ["tag-a", "tag-b"],
        ["标签甲", "标签乙"]
      )
    );
  }
  let t0 = Date.now();
  bigProblems.replaceAll(bigRows);
  await bigProblems.save(bigAdapter as never);
  const saveMs = Date.now() - t0;
  const csvBytes = (await bigAdapter.read(".leetcode/problems.csv")).length;

  const bigProblems2 = new ProblemStore();
  t0 = Date.now();
  await bigProblems2.load(bigAdapter as never);
  const loadMs = Date.now() - t0;

  assert(bigProblems2.size === 4498, `压测题库应为 4498 题，实际 ${bigProblems2.size}`);

  const bigRecords = new RecordStore();
  await bigRecords.load(bigAdapter as never);

  t0 = Date.now();
  let totalWritten = 0;
  // 模拟 20 轮同步，每轮 1000 条
  for (let round = 0; round < 20; round++) {
    const batch: RecordRow[] = [];
    for (let k = 0; k < 1000; k++) {
      const idx = (round * 1000 + k) % 4498 + 1;
      batch.push(
        mkRecord(
          `bs-${round}-${k}`,
          `problem-${idx}`,
          k % 4 === 0 ? "Accepted" : "Wrong Answer",
          T2026 + round * 100 + k
        )
      );
    }
    totalWritten += await bigRecords.appendRows(bigAdapter as never, batch);
  }
  const appendMs = Date.now() - t0;

  const reloadRecords = new RecordStore();
  t0 = Date.now();
  await reloadRecords.load(bigAdapter as never);
  const reloadMs = Date.now() - t0;

  assert(totalWritten === 20000, `压测应写入 20000 条，实际 ${totalWritten}`);
  assert(reloadRecords.count === 20000, `重载后应为 20000 条，实际 ${reloadRecords.count}`);

  const recBytes = (await bigAdapter.read(".leetcode/records.csv")).length;

  console.log("\n┌─ 实测数字 ─────────────────────────────────");
  console.log(`│ problems.csv  ${(csvBytes / 1024).toFixed(0)} KB · ${4498} 行 · 写入 ${saveMs} ms · 读取 ${loadMs} ms`);
  console.log(`│ records.csv   ${(recBytes / 1024).toFixed(0)} KB · 20000 行 · 追加 20 批 ${appendMs} ms · 读取 ${reloadMs} ms`);
  console.log(`│ 平均追加一批  ${(appendMs / 20).toFixed(1)} ms`);
  console.log("└────────────────────────────────────────────");

  // ---------------------------------------------------------------- 轮次
  section("轮次：事件重放与时间窗计数");

  const evAdapter = new FsAdapter();
  const events = new EventStore();

  await events.load(evAdapter as never);
  assert(events.buildRounds().length === 0, "无事件时不应有轮次");

  // 第一次全部重置 → 第 1 轮进行中
  await events.append(evAdapter as never, { at: T2026, kind: "all", slug: "" });
  {
    const rs = events.buildRounds();
    assert(rs.length === 1, `一次全量重置应得到 1 轮，实际 ${rs.length}`);
    assert(rs[0].index === 1, "轮次编号应从 1 开始");
    assert(rs[0].start === T2026, "第 1 轮起点应是重置时刻");
    assert(rs[0].end === null, "进行中的轮次 end 应为 null");
  }

  // 第二次全部重置 → 第 1 轮关闭，第 2 轮开始
  const T_R2 = T2026 + 3600;
  await events.append(evAdapter as never, { at: T_R2, kind: "all", slug: "" });
  {
    const rs = events.buildRounds();
    assert(rs.length === 2, `两次全量重置应得到 2 轮，实际 ${rs.length}`);
    assert(rs[0].end === T_R2, "第 1 轮终点应是下一轮起点");
    assert(rs[1].start === T_R2 && rs[1].end === null, "第 2 轮应从第二次重置开始且进行中");
  }

  // 单题重置不切轮
  await events.append(evAdapter as never, { at: T_R2 + 60, kind: "single", slug: "two-sum" });
  assert(events.buildRounds().length === 2, "单题重置不应新开轮次");

  // 撤销全部重置 → 关闭进行中的轮，但不删除历史
  const T_CLR = T_R2 + 120;
  await events.append(evAdapter as never, { at: T_CLR, kind: "clear_all", slug: "" });
  {
    const rs = events.buildRounds();
    assert(rs.length === 2, "撤销不应删除已发生的轮次");
    assert(rs[1].end === T_CLR, "撤销全部重置应关闭进行中的那一轮");
    assert(events.currentRound() === null, "撤销后不应存在进行中的轮次");
  }

  // 撤销后再重置 → 第 3 轮
  await events.append(evAdapter as never, { at: T_CLR + 60, kind: "all", slug: "" });
  {
    const rs = events.buildRounds();
    assert(rs.length === 3 && rs[2].end === null, "撤销后再重置应开出第 3 轮");
    assert(events.currentRound()?.index === 3, "当前轮应是第 3 轮");
  }

  // 落盘 → 重载一致
  const events2 = new EventStore();
  await events2.load(evAdapter as never);
  assert(events2.count === events.count, "事件应完整落盘并可重载");
  assert(events2.buildRounds().length === 3, "重载后轮次数量应一致");
  const evText = await evAdapter.read(".leetcode/events.csv");
  assert(evText.split("\n")[0] === "at,kind,slug", "事件文件表头正确");

  // 时间窗计数：左闭右开
  const roundAdapter = new FsAdapter();
  const roundRec = new RecordStore();
  await roundRec.appendRows(roundAdapter as never, [
    mkRecord("r1", "a", "Accepted", T2026 + 100),
    mkRecord("r2", "b", "Accepted", T_R2),
    mkRecord("r3", "a", "Accepted", T_R2 + 80),
    mkRecord("r4", "c", "Accepted", T2026 - 100),
    mkRecord("r5", "d", "Wrong Answer", T_R2 + 10),
  ]);
  assert(roundRec.hasAcInRange("a", T2026, T_R2), "a 在第 1 轮时间窗内");
  assert(!roundRec.hasAcInRange("b", T2026, T_R2), "b 的 AC 落在右边界，不属于第 1 轮");
  assert(roundRec.hasAcInRange("b", T_R2, T_CLR), "b 的 AC 落在左边界，属于第 2 轮");
  assert(roundRec.hasAcInRange("a", T_R2, T_CLR), "a 在第 2 轮又做了一次");
  assert(!roundRec.hasAcInRange("c", T2026, T_R2), "重置前的 AC 不落进任何轮次");
  assert(!roundRec.hasAcInRange("d", T_R2, T_CLR), "非 Accepted 不计入");

  // 同一题跨多轮：两轮各自都应命中
  assert(
    roundRec.hasAcInRange("a", T2026, T_R2) && roundRec.hasAcInRange("a", T_R2, T_CLR),
    "一题在两轮都做过时，两轮都应统计到它"
  );

  // ---------------------------------------------------------------- 汇总
  console.log(`\n${"─".repeat(48)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${passed} 项断言`);
  } else {
    console.log(`失败 ${failures.length} 项 / 通过 ${passed} 项`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("测试崩溃：", e);
  process.exitCode = 1;
});

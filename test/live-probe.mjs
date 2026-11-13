/**
 * 用真实的 leetcode.cn 接口跑一遍题库全量同步，验证：
 *  - limit 上限是不是真的 100
 *  - 45 页的 skip 递增 + hasMore 终止条件对不对
 *  - 全量耗时和最终条数
 * 产物：tmp/problems-live.csv（格式与插件写出的完全一致）
 */
import { writeFileSync, mkdirSync } from "fs";

// 与 src/store/csv.ts、src/store/paths.ts 保持一致（此处内联，避免 ESM 导入 .ts）
function csvField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const csvLine = (fields) => fields.map(csvField).join(",") + "\n";
const PROBLEMS_HEADER = [
  "frontend_id", "slug", "title_cn", "title", "difficulty",
  "ac_rate", "paid_only", "tags", "tags_cn", "url", "retired",
];

const ENDPOINT = "https://leetcode.cn/graphql/";
const PAGE_SIZE = 100;
const DELAY = 600;

const Q = `
query problemsetQuestionList($limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList(categorySlug: "", limit: $limit, skip: $skip, filters: $filters) {
    total
    hasMore
    questions {
      frontendQuestionId
      titleSlug
      title
      titleCn
      difficulty
      acRate
      paidOnly
      topicTags { slug name nameTranslated }
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(skip) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://leetcode.cn/problemset/",
      Origin: "https://leetcode.cn",
    },
    body: JSON.stringify({ query: Q, variables: { limit: PAGE_SIZE, skip, filters: {} } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.problemsetQuestionList;
}

const started = Date.now();
const rows = [];
let total = 0;
let skip = 0;
let pages = 0;

while (true) {
  const p = await page(skip);
  total = p.total || total;
  pages += 1;
  const got = p.questions.length;
  for (const q of p.questions) {
    rows.push({
      id: q.frontendQuestionId,
      slug: q.titleSlug,
      cn: q.titleCn,
      en: q.title,
      diff: q.difficulty,
      rate: q.acRate,
      paid: q.paidOnly,
      tags: (q.topicTags || []).map((t) => t.slug),
      tagsCn: (q.topicTags || []).map((t) => t.nameTranslated || t.name),
    });
  }
  process.stdout.write(`  第 ${String(pages).padStart(2)} 页 skip=${String(skip).padStart(4)} 返回 ${String(got).padStart(3)} 条  累计 ${rows.length}/${total}\n`);

  skip += PAGE_SIZE;
  if (!p.hasMore || skip >= total || got === 0) break;
  await sleep(DELAY);
}

const elapsed = Date.now() - started;

// ---- 一致性检查
const slugs = new Set(rows.map((r) => r.slug));
assert(rows.length === total, `条数应与 total 一致：${rows.length} vs ${total}`);
assert(slugs.size === rows.length, `slug 应无重复：${slugs.size} vs ${rows.length}`);
assert(pages === Math.ceil(total / PAGE_SIZE), `页数应为 ceil(total/100)=${Math.ceil(total / PAGE_SIZE)}，实际 ${pages}`);

// ---- 生成与插件一致的 CSV
mkdirSync("tmp", { recursive: true });
const lines = [csvLine(PROBLEMS_HEADER)];
for (const r of rows) {
  lines.push(
    csvLine([
      r.id, r.slug, r.cn, r.en, r.diff, r.rate, r.paid ? 1 : 0,
      r.tags.join("|"), r.tagsCn.join("|"),
      `https://leetcode.cn/problems/${r.slug}/`, 0,
    ])
  );
}
writeFileSync("tmp/problems-live.csv", lines.join(""), "utf8");

// ---- 统计
const byDiff = rows.reduce((a, r) => ((a[r.diff] = (a[r.diff] || 0) + 1), a), {});
const paidCount = rows.filter((r) => r.paid).length;
const tagSet = new Set(rows.flatMap((r) => r.tags));

console.log("\n┌─ 真实题库同步 ────────────────────────────");
console.log(`│ total        ${total}`);
console.log(`│ 拿到条数      ${rows.length}（去重后 ${slugs.size}）`);
console.log(`│ 页数          ${pages}`);
console.log(`│ 耗时          ${(elapsed / 1000).toFixed(1)} 秒`);
console.log(`│ 难度分布      EASY ${byDiff.EASY || 0} / MEDIUM ${byDiff.MEDIUM || 0} / HARD ${byDiff.HARD || 0}`);
console.log(`│ 会员题        ${paidCount}`);
console.log(`│ 不同标签      ${tagSet.size}`);
console.log(`│ CSV 已写出    tmp/problems-live.csv`);
console.log("└──────────────────────────────────────────");

function assert(cond, msg) {
  if (!cond) {
    console.log(`\n✗ 断言失败：${msg}`);
    process.exitCode = 1;
  }
}

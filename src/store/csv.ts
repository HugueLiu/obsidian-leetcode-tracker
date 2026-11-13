/**
 * 最小 RFC 4180 CSV 解析/序列化。
 * 只处理一种方言：逗号分隔、双引号包裹、双引号内部转义为 ""。
 */

export interface CsvParseResult {
  rows: string[][];
  /** 原文是否以换行结尾。false 表示最后一行可能被截断，调用方应决定是否丢弃。 */
  endedWithNewline: boolean;
}

export function parseCsv(text: string): CsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === "," || ch === "\t") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  const endedWithNewline = n > 0 && text[n - 1] === "\n";
  if (!endedWithNewline && (field.length > 0 || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }

  return { rows, endedWithNewline };
}

export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (s === "") return "";
  if (s.indexOf('"') !== -1 || s.indexOf(",") !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function csvLine(fields: unknown[]): string {
  return fields.map(csvField).join(",") + "\n";
}

/** 解析 "a|b|c" 形式的多值列，空串返回空数组 */
export function splitMulti(s: string, sep = "|"): string[] {
  if (!s) return [];
  return s.split(sep).filter((x) => x.length > 0);
}

export function joinMulti(list: string[], sep = "|"): string {
  return list.filter((x) => x.length > 0).join(sep);
}

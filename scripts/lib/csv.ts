#!/usr/bin/env bun
// RFC4180 CSV shared by prep_data.ts and fetch_tags.ts, ported from
// csv.DictReader(encoding="utf-8-sig", newline=""): quoted fields, embedded
// delimiters/newlines, "" escapes, CR-LF records, leading BOM stripped.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state = "START_RECORD";
  const saveField = () => {
    row.push(field);
    field = "";
  };
  const saveRow = () => {
    rows.push(row);
    row = [];
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    switch (state) {
      case "START_RECORD":
        if (c === "\n" || c === "\r") i++; // blank record: skipped
        else state = "START_FIELD";
        break;
      case "START_FIELD":
        if (c === '"') {
          state = "IN_QUOTED_FIELD";
          i++;
        } else if (c === ",") {
          saveField();
          i++;
        } else if (c === "\n" || c === "\r") {
          saveField();
          saveRow();
          state = "EAT_CRNL";
          i++;
        } else {
          field += c;
          state = "IN_FIELD";
          i++;
        }
        break;
      case "IN_FIELD":
        if (c === "\n" || c === "\r") {
          saveField();
          saveRow();
          state = "EAT_CRNL";
          i++;
        } else if (c === ",") {
          saveField();
          state = "START_FIELD";
          i++;
        } else {
          field += c;
          i++;
        }
        break;
      case "IN_QUOTED_FIELD":
        if (c === '"') {
          state = "QUOTE_IN_QUOTED_FIELD";
          i++;
        } else {
          field += c; // CR-LF inside quotes is kept verbatim
          i++;
        }
        break;
      case "QUOTE_IN_QUOTED_FIELD":
        if (c === '"') {
          field += '"';
          state = "IN_QUOTED_FIELD";
          i++;
        } else if (c === ",") {
          saveField();
          state = "START_FIELD";
          i++;
        } else if (c === "\n" || c === "\r") {
          saveField();
          saveRow();
          state = "EAT_CRNL";
          i++;
        } else {
          field += c;
          state = "IN_FIELD";
          i++;
        }
        break;
      case "EAT_CRNL":
        if (c === "\n" || c === "\r") i++;
        else state = "START_RECORD";
        break;
    }
  }
  if (state === "IN_QUOTED_FIELD") throw new Error("csv: unexpected end of data");
  if (state === "START_FIELD" || state === "IN_FIELD" || state === "QUOTE_IN_QUOTED_FIELD") {
    saveField();
    saveRow();
  }
  return rows;
}

// DictReader: first row is the header; short rows read as null, extras under
// the None restkey are dropped (unused by the transforms).
export function csvDicts(text: string): Record<string, string | null>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const d: Record<string, string | null> = {};
    header.forEach((h, i) => {
      d[h] = i < r.length ? r[i] : null;
    });
    return d;
  });
}

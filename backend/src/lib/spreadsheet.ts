import * as XLSX from "xlsx";

function cellDisplayText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  if (typeof cell.w === "string" && cell.w.length > 0) return cell.w;
  if (cell.v == null) return "";
  return String(cell.v);
}

function sanitizeCellText(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function renderSheet(sheetName: string, ws: XLSX.WorkSheet): string | null {
  const ref = ws["!ref"];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  const mergeAnchors = new Map<string, string>();
  for (const merge of ws["!merges"] ?? []) {
    mergeAnchors.set(
      XLSX.utils.encode_cell(merge.s),
      XLSX.utils.encode_range(merge),
    );
  }

  const rows: { rowNumber: number; cells: string[] }[] = [];
  let lastNonEmptyCol = -1;

  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: string[] = [];
    let rowHasContent = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      let text = sanitizeCellText(cellDisplayText(ws[addr]));
      const mergeRange = mergeAnchors.get(addr);
      if (mergeRange) {
        text = text ? `${text} (merged ${mergeRange})` : `(merged ${mergeRange})`;
      }
      cells[c - range.s.c] = text;
      if (text) {
        rowHasContent = true;
        lastNonEmptyCol = Math.max(lastNonEmptyCol, c - range.s.c);
      }
    }
    if (rowHasContent) rows.push({ rowNumber: r + 1, cells });
  }

  if (rows.length === 0 || lastNonEmptyCol < 0) return null;

  const colLetters: string[] = [];
  for (let c = 0; c <= lastNonEmptyCol; c++) {
    colLetters.push(XLSX.utils.encode_col(range.s.c + c));
  }

  const headerRow = `| Row | ${colLetters.join(" | ")} |`;
  const separator = `| --- | ${colLetters.map(() => "---").join(" | ")} |`;
  const bodyRows = rows.map(({ rowNumber, cells }) => {
    const padded: string[] = [];
    for (let c = 0; c <= lastNonEmptyCol; c++) padded.push(cells[c] ?? "");
    return `| ${rowNumber} | ${padded.join(" | ")} |`;
  });

  return [`## Sheet: ${sheetName}`, "", headerRow, separator, ...bodyRows].join(
    "\n",
  );
}

export function spreadsheetToLLMText(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheets: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rendered = renderSheet(sheetName, ws);
    if (rendered) sheets.push(rendered);
  }
  return sheets.join("\n\n").trim();
}

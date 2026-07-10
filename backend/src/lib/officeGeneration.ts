import JSZip from "jszip";
import * as XLSX from "xlsx";

/**
 * Docket-native builders for assistant-created Office files.
 *
 * The builders deliberately accept a small, structured subset of Excel and
 * PowerPoint rather than model-authored Office XML. That keeps generated files
 * deterministic, prevents formula execution from untrusted text, and lets the
 * chat tool persist the result through the ordinary document/version pipeline.
 */

const MAX_SHEETS = 25;
const MAX_COLUMNS_PER_SHEET = 100;
const MAX_ROWS_PER_SHEET = 5_000;
const MAX_SLIDES = 100;
const MAX_BULLETS_PER_SLIDE = 100;
const MAX_CELL_TEXT_LENGTH = 32_767; // Excel's maximum cell-text length.
const MAX_SLIDE_TEXT_LENGTH = 16_000;

type NormalizedSheet = {
  name: string;
  columns: string[];
  rows: string[][];
};

type NormalizedSlide = {
  title: string;
  bullets: string[];
};

function normalizedText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .slice(0, maxLength);
}

function normalizedTitle(value: unknown, fallback: string): string {
  const title =
    typeof value === "string" ? normalizedText(value, 200).trim() : "";
  return title || fallback;
}

/**
 * Filename handling is local to Office generation so it cannot change the
 * historical DOCX naming contract. The extension is always controlled by the
 * server rather than model input.
 */
export function generatedOfficeFilename(
  title: unknown,
  extension: "xlsx" | "pptx",
): string {
  const fallback = extension === "xlsx" ? "workbook" : "presentation";
  const safeTitle = normalizedTitle(title, fallback)
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .slice(0, 64);
  return `${safeTitle || fallback}.${extension}`;
}

function normalizeSheetName(
  value: unknown,
  fallback: string,
  used: Set<string>,
): string {
  const base = normalizedText(value, 128)
    .replace(/[:\\/?*\[\]]/g, " ")
    .trim()
    .slice(0, 31) || fallback;

  let candidate = base;
  let duplicateIndex = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const suffix = ` (${duplicateIndex})`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length)).trim()}${suffix}`;
    duplicateIndex += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function normalizeWorkbookSheets(
  title: string,
  sheetsInput: unknown,
): NormalizedSheet[] {
  const suppliedSheets = Array.isArray(sheetsInput) ? sheetsInput : [];
  if (suppliedSheets.length > MAX_SHEETS) {
    throw new Error(`A workbook may contain at most ${MAX_SHEETS} sheets.`);
  }

  const rawSheets = suppliedSheets.length
    ? suppliedSheets
    : [{ name: title, columns: [], rows: [] }];
  const usedNames = new Set<string>();

  return rawSheets.map((sheet, index) => {
    const raw =
      sheet && typeof sheet === "object"
        ? (sheet as { name?: unknown; columns?: unknown; rows?: unknown })
        : {};
    const rawColumns = Array.isArray(raw.columns) ? raw.columns : [];
    if (rawColumns.length > MAX_COLUMNS_PER_SHEET) {
      throw new Error(
        `Sheet ${index + 1} has more than ${MAX_COLUMNS_PER_SHEET} columns.`,
      );
    }

    const columns = rawColumns
      .map((column, columnIndex) => {
        const text = normalizedText(column, MAX_CELL_TEXT_LENGTH).trim();
        return text || `Column ${columnIndex + 1}`;
      })
      .slice(0, MAX_COLUMNS_PER_SHEET);
    const normalizedColumns = columns.length ? columns : ["Value"];

    const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
    if (rawRows.length > MAX_ROWS_PER_SHEET) {
      throw new Error(
        `Sheet ${index + 1} has more than ${MAX_ROWS_PER_SHEET} rows.`,
      );
    }

    const rows = rawRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) =>
        normalizedColumns.map((_, columnIndex) =>
          normalizedText(row[columnIndex], MAX_CELL_TEXT_LENGTH),
        ),
      );

    return {
      name: normalizeSheetName(raw.name, `Sheet ${index + 1}`, usedNames),
      columns: normalizedColumns,
      rows,
    };
  });
}

function worksheetColumnWidths(sheet: NormalizedSheet): { wch: number }[] {
  return sheet.columns.map((header, columnIndex) => {
    const longest = Math.max(
      header.length,
      ...sheet.rows.map((row) => row[columnIndex]?.length ?? 0),
    );
    return { wch: Math.min(Math.max(longest + 2, 10), 50) };
  });
}

/** Build an ordinary .xlsx workbook using Docket's existing SheetJS runtime. */
export function buildXlsxWorkbook(
  titleInput: unknown,
  sheetsInput: unknown,
): Buffer {
  const title = normalizedTitle(titleInput, "Workbook");
  const sheets = normalizeWorkbookSheets(title, sheetsInput);
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: title,
    Author: "Docket",
    Company: "Docket",
    CreatedDate: new Date(),
  };

  for (const sheet of sheets) {
    // Every value is supplied as a string. In particular, a model-produced
    // value beginning with "=" remains literal cell text instead of becoming
    // an Excel formula when the recipient opens the file.
    const worksheet = XLSX.utils.aoa_to_sheet([
      sheet.columns,
      ...sheet.rows,
    ]);
    const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1");
    worksheet["!cols"] = worksheetColumnWidths(sheet);
    worksheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(range.e.r, 0), c: Math.max(range.e.c, 0) },
      }),
    };
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  return Buffer.from(
    XLSX.write(workbook, {
      bookType: "xlsx",
      type: "buffer",
      compression: true,
    }),
  );
}

function xmlEscape(value: unknown): string {
  return normalizedText(value, MAX_SLIDE_TEXT_LENGTH)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeSlides(title: string, slidesInput: unknown): NormalizedSlide[] {
  const suppliedSlides = Array.isArray(slidesInput) ? slidesInput : [];
  if (suppliedSlides.length > MAX_SLIDES) {
    throw new Error(`A presentation may contain at most ${MAX_SLIDES} slides.`);
  }
  const rawSlides = suppliedSlides.length
    ? suppliedSlides
    : [{ title, bullets: ["Generated by Docket"] }];

  return rawSlides.map((slide, index) => {
    const raw =
      slide && typeof slide === "object"
        ? (slide as { title?: unknown; bullets?: unknown })
        : {};
    const rawBullets = Array.isArray(raw.bullets) ? raw.bullets : [];
    if (rawBullets.length > MAX_BULLETS_PER_SLIDE) {
      throw new Error(
        `Slide ${index + 1} has more than ${MAX_BULLETS_PER_SLIDE} bullets.`,
      );
    }
    return {
      title: normalizedTitle(raw.title, index === 0 ? title : `Slide ${index + 1}`),
      bullets: rawBullets
        .map((bullet) => normalizedText(bullet, MAX_SLIDE_TEXT_LENGTH).trim())
        .filter(Boolean),
    };
  });
}

function pptTextParagraphs(lines: string[], options: { title?: boolean } = {}) {
  return lines
    .map((line) => {
      const titleAttrs = options.title ? ' sz="3200" b="1"' : ' sz="2000"';
      const bullet = options.title
        ? ""
        : '<a:pPr marL="342900" indent="-171450"><a:buChar char="&#8226;"/></a:pPr>';
      return `<a:p>${bullet}<a:r><a:rPr lang="en-US"${titleAttrs}/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`;
    })
    .join("");
}

function pptShape(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  body: string,
) {
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
  <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody>
</p:sp>`;
}

/**
 * Build a compact, standards-based 16:9 .pptx package. It intentionally
 * supports the same legal-assistant contract as upstream (title + bullets),
 * without importing its storage or auth assumptions.
 */
export async function buildPptxPresentation(
  titleInput: unknown,
  slidesInput: unknown,
): Promise<Buffer> {
  const title = normalizedTitle(titleInput, "Presentation");
  const slides = normalizeSlides(title, slidesInput);
  const zip = new JSZip();
  const now = new Date().toISOString();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slides.map((_, index) => `  <Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Docket</dc:creator>
  <cp:lastModifiedBy>Docket</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Docket</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>${slides.length}</Slides>
</Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slides.length + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slides.map((_, index) => `    <p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("\n")}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides.map((_, index) => `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("\n")}
  <Relationship Id="rId${slides.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
</p:sldLayout>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Docket">
  <a:themeElements>
    <a:clrScheme name="Office"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="059669"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );

  for (const [index, slide] of slides.entries()) {
    const bullets = slide.bullets.length ? slide.bullets : [""];
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${pptShape(2, "Title", 685800, 457200, 10820400, 914400, pptTextParagraphs([slide.title], { title: true }))}
      ${pptShape(3, "Content", 914400, 1600200, 10363200, 4343400, pptTextParagraphs(bullets))}
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    );
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

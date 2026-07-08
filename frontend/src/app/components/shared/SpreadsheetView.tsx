"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import LuckyExcel from "luckyexcel";
import type { Sheet } from "@fortune-sheet/core";
import type { WorkbookInstance } from "@fortune-sheet/react";
import "@fortune-sheet/react/dist/index.css";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";

type WorkbookComponent = typeof import("@fortune-sheet/react").Workbook;

interface Props {
    documentId: string;
    versionId?: string | null;
    rounded?: boolean;
    bordered?: boolean;
}

type LuckyExport = {
    sheets?: unknown[];
};

type MergeInfo = { r: number; c: number; rs: number; cs: number };
type CellData = { r: number; c: number; v: Record<string, unknown> };

function applyMergeCells(sheets: unknown[]): void {
    for (const rawSheet of sheets) {
        const sheet = rawSheet as {
            config?: { merge?: Record<string, MergeInfo> };
            celldata?: CellData[];
        };
        const merges = sheet.config?.merge;
        if (!merges) continue;
        if (!Array.isArray(sheet.celldata)) sheet.celldata = [];
        const byKey = new Map<string, CellData>();
        for (const entry of sheet.celldata) {
            if (typeof entry?.r === "number" && typeof entry?.c === "number") {
                byKey.set(`${entry.r}_${entry.c}`, entry);
            }
        }
        const ensureCell = (r: number, c: number): CellData => {
            const key = `${r}_${c}`;
            let entry = byKey.get(key);
            if (!entry) {
                entry = { r, c, v: {} };
                sheet.celldata!.push(entry);
                byKey.set(key, entry);
            }
            if (!entry.v || typeof entry.v !== "object") entry.v = {};
            return entry;
        };
        for (const merge of Object.values(merges)) {
            ensureCell(merge.r, merge.c).v.mc = {
                r: merge.r,
                c: merge.c,
                rs: merge.rs,
                cs: merge.cs,
            };
            for (let r = merge.r; r < merge.r + merge.rs; r++) {
                for (let c = merge.c; c < merge.c + merge.cs; c++) {
                    if (r === merge.r && c === merge.c) continue;
                    ensureCell(r, c).v.mc = { r: merge.r, c: merge.c };
                }
            }
        }
    }
}

function applyExcelTextOverflow(sheets: unknown[]): void {
    for (const rawSheet of sheets) {
        const sheet = rawSheet as { celldata?: { v?: Record<string, unknown> }[] };
        if (!Array.isArray(sheet.celldata)) continue;
        for (const entry of sheet.celldata) {
            const cell = entry.v;
            if (!cell || typeof cell !== "object") continue;
            if (cell.mc || cell.tb === "2") continue;
            if (typeof cell.v === "string" && cell.v.length > 0) cell.tb = "1";
        }
    }
}

export function SpreadsheetView({
    documentId,
    versionId,
    rounded = true,
    bordered = true,
}: Props) {
    const [WorkbookComponent, setWorkbookComponent] =
        useState<WorkbookComponent | null>(null);
    const workbookRef = useRef<WorkbookInstance>(null);
    const [sheets, setSheets] = useState<Sheet[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { result, error: fetchError } = useFetchSingleDoc(
        documentId,
        versionId,
    );

    useEffect(() => {
        let cancelled = false;
        import("@fortune-sheet/react").then((mod) => {
            if (!cancelled) setWorkbookComponent(() => mod.Workbook);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!result) return;
        if (result.type !== "spreadsheet") {
            setError("This spreadsheet could not be displayed.");
            return;
        }
        let cancelled = false;
        setError(null);
        setSheets(null);
        try {
            const file = new File([result.buffer], "spreadsheet.xlsx");
            LuckyExcel.transformExcelToLucky(file, (exportJson: LuckyExport) => {
                if (cancelled) return;
                if (exportJson?.sheets?.length) {
                    applyMergeCells(exportJson.sheets);
                    applyExcelTextOverflow(exportJson.sheets);
                    setSheets(exportJson.sheets as Sheet[]);
                } else {
                    setError("This spreadsheet could not be displayed.");
                }
            });
        } catch {
            if (!cancelled) setError("This spreadsheet could not be displayed.");
        }
        return () => {
            cancelled = true;
        };
    }, [result]);

    const frameClass = [
        "fortune-sheet-viewer relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white",
        rounded ? "rounded-lg" : "",
        bordered ? "border border-gray-200" : "",
    ]
        .filter(Boolean)
        .join(" ");

    const message = error ?? (fetchError ? "Failed to load spreadsheet." : null);
    if (message) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
                    {message}
                </div>
            </div>
        );
    }

    if (!sheets || !WorkbookComponent) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                </div>
            </div>
        );
    }

    return (
        <div className={frameClass}>
            <WorkbookComponent
                ref={workbookRef}
                data={sheets}
                allowEdit={false}
                showToolbar={false}
                showFormulaBar={false}
            />
        </div>
    );
}

declare module "luckyexcel" {
  export type LuckyExcelSheet = Record<string, unknown>;

  const LuckyExcel: {
    transformExcelToLucky: (
      file: File,
      callback: (exportJson: { sheets?: unknown[] }) => void,
    ) => void;
  };

  export default LuckyExcel;
}

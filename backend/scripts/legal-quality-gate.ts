import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { runLegalOutputBenchmark, type LegalBenchmarkCorpus } from "../src/lib/legalOutputBenchmark";
import { legalTextHash } from "../src/lib/legalOutputGate";

async function main() {
    const args = process.argv.slice(2);
    const corpusIndex = args.indexOf("--corpus");
    const reportIndex = args.indexOf("--report");
    const corpusPath = corpusIndex >= 0 ? resolve(args[corpusIndex + 1]) : resolve(__dirname, "../test/fixtures/legal-output-benchmark.json");
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as LegalBenchmarkCorpus;
    const report = await runLegalOutputBenchmark(corpus);
    let gitSha = "unavailable";
    try { gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* A source archive can still run the gate. */ }
    const sourceHashes = Object.fromEntries(["legalOutputGate.ts", "legalOutputBenchmark.ts", "chatTools.ts"].map((filename) => [filename, legalTextHash(readFileSync(resolve(__dirname, "../src/lib", filename), "utf8"))]));
    const measured = { ...report, measuredAt: new Date().toISOString(), gitSha, sourceHashes, nodeVersion: process.version };
    if (reportIndex >= 0) {
        const reportPath = resolve(args[reportIndex + 1]);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, JSON.stringify(measured, null, 2) + "\n");
    }
    console.log(JSON.stringify({ passed: report.passed, benchmarkVersion: report.benchmarkVersion, corpusHash: report.corpusHash, thresholds: report.thresholds, metrics: report.metrics, failures: report.failures }, null, 2));
    if (!report.passed) process.exitCode = 1;
}
main().catch((error) => { console.error(`Legal quality release gate failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

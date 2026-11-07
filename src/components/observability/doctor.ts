export type CheckStatus = "pass" | "warn" | "fail" | "none";

export type CheckResult = {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  remediation?: string;
};

export type DoctorReport = {
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number; none: number };
  exitCode: number;
};

const EXIT_BY_PREFIX: ReadonlyArray<[string, number]> = [
  ["config.", 2],
  ["version.", 3],
  ["auth.", 3],
  ["dsh.", 4],
  ["state.", 4],
  ["session.", 4],
  ["orphan.", 4],
  ["workspace.", 5],
  ["asset.", 5],
  ["scheduler.", 6],
];

function blockingExitCode(check: CheckResult): number | undefined {
  if (check.status !== "fail") return undefined;
  for (const [prefix, code] of EXIT_BY_PREFIX) {
    if (check.id.startsWith(prefix)) return code;
  }
  return 4;
}

/** 聚合检查项；不执行检查、不读文件。 */
export function collect(checks: readonly CheckResult[]): DoctorReport {
  const summary = { pass: 0, warn: 0, fail: 0, none: 0 };
  for (const check of checks) summary[check.status] += 1;
  const codes = checks
    .map((check) => blockingExitCode(check))
    .filter((code): code is number => code !== undefined);
  const exitCode = codes.length === 0 ? 0 : Math.min(...codes);
  return { checks: [...checks], summary, exitCode };
}

function formatLine(check: CheckResult): string {
  const label = check.status.toUpperCase().padEnd(4, " ");
  const detail = check.detail === undefined ? "" : `  ${check.detail}`;
  return `[${label}] ${check.id} ${check.title}${detail}`;
}

/** 纯渲染；`json` 只输出报告，不混日志。 */
export function render(report: DoctorReport, format: "human" | "json"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines = report.checks.map(formatLine);
  for (const check of report.checks) {
    if (check.status === "fail" && check.remediation !== undefined) {
      lines.push(`        修复：${check.remediation}`);
    }
  }
  lines.push(
    `结论：pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} none=${report.summary.none}，退出码 ${report.exitCode}`,
  );
  return lines.join("\n");
}

export function exitCode(report: DoctorReport): number {
  return report.exitCode;
}

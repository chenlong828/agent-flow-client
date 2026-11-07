/** CLI 退出码（architecture.md §3.2，2026-11-08 冻结）。 */
export const ExitCode = {
  ok: 0,
  nodeFailed: 1,
  usage: 2,
  auth: 3,
  runtime: 4,
  workspace: 5,
  scheduler: 6,
  runSuperseded: 7,
  sigint: 130,
  sigterm: 143,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

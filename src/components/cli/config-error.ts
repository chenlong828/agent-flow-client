/** 配置/用法错误：带稳定 code 与 CLI 退出码，由入口统一渲染。 */
export class ConfigError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

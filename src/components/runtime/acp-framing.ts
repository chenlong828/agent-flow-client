/** ACP stdio 分行与进程组信号辅助。 */
export class LineFramer {
  #buffer = "";

  push(chunk: Buffer): string[] {
    this.#buffer += chunk.toString("utf8");
    const lines: string[] = [];
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line !== "") lines.push(line);
      index = this.#buffer.indexOf("\n");
    }
    return lines;
  }
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已退出。
    }
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

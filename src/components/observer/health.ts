/** 观测面健康状态：连续写盘/归档失败 3 次置 degraded，成功一次恢复。 */
export class ObserverHealth {
  #failures = 0;
  #degraded = false;

  fail(): void {
    this.#failures += 1;
    if (this.#failures >= 3) this.#degraded = true;
  }

  ok(): void {
    this.#failures = 0;
    this.#degraded = false;
  }

  get degraded(): boolean {
    return this.#degraded;
  }
}

export type ContainerGuard = { digest: string; attempts: Set<string> };

/** 同容器技能集守卫：有其它活跃 attempt 且 digest 不同即冲突（CMP-executor §2.6）。 */
export function claimContainer(
  containers: Map<string, ContainerGuard>,
  root: string,
  attemptId: string,
  digest: string,
): void {
  const guard = containers.get(root);
  if (guard !== undefined && guard.attempts.size > 0 && guard.digest !== digest) {
    throw Object.assign(new Error("同容器存在不同技能集的活跃 attempt"), { code: "asset_skill_set_conflict" });
  }
  const entry = guard ?? { digest, attempts: new Set<string>() };
  entry.digest = digest;
  entry.attempts.add(attemptId);
  containers.set(root, entry);
}

export function releaseContainer(containers: Map<string, ContainerGuard>, root: string, attemptId: string): void {
  const entry = containers.get(root);
  if (entry === undefined) return;
  entry.attempts.delete(attemptId);
  if (entry.attempts.size === 0) containers.delete(root);
}

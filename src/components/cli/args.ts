export type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_FLAGS = new Set([
  "--config",
  "--state-root",
  "--log-level",
  "--permission",
  "--request",
  "--workspace",
]);

const BOOLEAN_FLAGS = new Set(["--help", "-h", "--version", "-v", "--json"]);

function isFlag(arg: string): boolean {
  return arg.startsWith("--") || arg === "-h" || arg === "-v";
}

function takeFlag(argv: readonly string[], index: number): { name: string; value: string | boolean; consumed: number } {
  const arg = argv[index] as string;
  const equals = arg.indexOf("=");
  const name = equals >= 0 ? arg.slice(0, equals) : arg;
  const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;

  if (BOOLEAN_FLAGS.has(name)) {
    if (inline !== undefined) throw new UsageError(`${name} 不接受值`);
    return { name, value: true, consumed: 1 };
  }
  if (!VALUE_FLAGS.has(name)) throw new UsageError(`未知选项：${name}`);
  const value = inline ?? argv[index + 1];
  if (value === undefined || value === "" || (inline === undefined && value.startsWith("-"))) {
    throw new UsageError(`${name} 需要一个值`);
  }
  return { name, value, consumed: inline === undefined ? 2 : 1 };
}

/** 解析 CLI 参数；未知 flag 直接报用法错误，不猜测。 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command = "";

  for (let index = 0; index < argv.length; ) {
    const arg = argv[index] as string;
    if (!isFlag(arg)) {
      if (command === "") command = arg;
      else positionals.push(arg);
      index += 1;
      continue;
    }
    const flag = takeFlag(argv, index);
    flags[flag.name] = flag.value;
    index += flag.consumed;
  }

  if (flags["-h"] === true || flags["--help"] === true) command = "help";
  if (flags["-v"] === true || flags["--version"] === true) command = "version";
  return { command, positionals, flags };
}

export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

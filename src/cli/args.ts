/** Minimal `--flag value` / `--flag` argv parser — no extra dependency needed for a handful of CLI commands. */
export function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

export async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);

  return new Promise(resolve => {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY && stdin.isRaw;
    let input = "";

    if (stdin.isTTY) stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "") {
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          return;
        } else if (char === "") {
          cleanup();
          process.exit(130);
        } else if (char === "") {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };

    function cleanup() {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode?.(!!wasRaw);
      stdin.pause();
    }

    stdin.on("data", onData);
  });
}

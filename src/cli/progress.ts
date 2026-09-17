export function renderProgress(current: number, total: number, label = "Downloading email") {
  const width = 30;
  const ratio = total > 0 ? current / total : 0;
  const filled = Math.round(width * ratio);
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  process.stdout.write(`\r[${bar}] ${label} ${current}/${total}`);
}

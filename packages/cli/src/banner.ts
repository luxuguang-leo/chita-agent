/**
 * chita startup banner — running cheetah ASCII logo with spots.
 *
 * Based on the classic cheetah ASCII art (ascii.co.uk, atc variant):
 * streamlined head, o/O/0 spots, arched back, tail. Rendered as a compact
 * 12-line logo. All monospace-safe.
 *
 * Layout mirrors the reference launch banner: logo left, info right
 * (version / model / cwd aligned columns).
 */

export interface BannerInfo {
  version: string;
  model?: string;
  cwd?: string;
  task?: string;
}

export const CHITA_LOGO = [
  "       _",
  "      / \\_,",
  "     !   `  `-._",
  "  ___/i._\\ }_/-'`-,",
  " '      //  ---//-'",
  "       /       /'",
  "     ,'o O o 0,'-.",
  "    :'o O 0/ 0 )__,",
  "    /o 0 0(),| o/-'",
  "    |`,,'  `._/0|\\',",
  "    |O|  `._/ \\o'||o",
  "     \\|    `._)  /(",
] as const;

/**
 * Render the banner: logo left, info right, aligned columns.
 */
export function renderBanner(info: BannerInfo): string {
  const lines: string[] = [];
  const logoWidth = Math.max(...CHITA_LOGO.map((l) => l.length));

  const rightCol: string[] = [];
  rightCol.push(`chita v${info.version}`);
  if (info.model) rightCol.push(`model  ${info.model}`);
  if (info.cwd) rightCol.push(`cwd    ${info.cwd}`);
  if (info.task) rightCol.push(`task   ${info.task.slice(0, 40)}`);

  for (let i = 0; i < CHITA_LOGO.length; i++) {
    const logoLine = CHITA_LOGO[i];
    const pad = logoWidth - logoLine.length;
    const info = rightCol[i] ?? "";
    lines.push(`${logoLine}${" ".repeat(pad + 6)}${info}`);
  }
  return lines.join("\n");
}

/** Print the banner (short = logo + version only, for --version). */
export function printBanner(info: BannerInfo, opts: { short?: boolean } = {}): void {
  if (opts.short) {
    console.log(CHITA_LOGO.join("\n"));
    console.log(`chita v${info.version}`);
    return;
  }
  console.log(renderBanner(info));
}

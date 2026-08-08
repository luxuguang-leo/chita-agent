/**
 * chita startup banner — cheetah-face ASCII logo with the signature
 * tear-streak lines (the species' most distinctive mark: black lines from
 * the inner eye corners down to the mouth).
 *
 * All characters are monospace-safe ASCII/box-drawing — no width-varying
 * glyphs — so the logo aligns on any terminal.
 *
 * Layout mirrors the reference launch banner: logo left, session info right
 * (version / model / cwd aligned columns).
 */

export interface BannerInfo {
  version: string;
  model?: string;
  cwd?: string;
  task?: string;
}

export const CHITA_LOGO = [
  "        ___________  ",
  "     __/___________\\__",
  "     /_   __   __   _\\",
  "    / /  /__\\ /__\\  \\ \\",
  "    | |   ~~   ~~   | |",
  "    | |_____________| |",
  "    |/   \\_______/   \\|",
  "    |\\___/_______\\___/|",
  "    |    ||     ||    |",
  "     \\___||_____||___/",
] as const;

/**
 * Render the banner: logo left, info right, aligned columns.
 * ```
 *          ___________          chita v0.1.0
 *       __/___________\\__      model  deepseek-v4-flash
 *      /_   __   __   _\\       cwd    ~
 *      ...
 * ```
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

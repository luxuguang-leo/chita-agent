/**
 * chita startup banner — cheetah head with tear marks.
 *
 * Rendered from the Vecteezy cheetah mascot artwork via PIL grayscale->ASCII
 * (60 cols), with the signature black tear marks (eye-to-cheek lines)
 * manually reinforced — they were lost when the full art was downscaled.
 * 27 lines, monospace-safe, bright-on-dark friendly.
 */

export interface BannerInfo {
  version: string;
  model?: string;
  cwd?: string;
  task?: string;
}

export const CHITA_LOGO = [
  "     .-:.                                          .:-",
  "    :*::-==-:                                  :-==-:-*.",
  "   .#.     .-+=.     .:-=====--====--:.     .=+-.     .#",
  "   += ...::.  :+=.-==-:      ::      :-==-.++:  .:::.. +=",
  "   *:      :=:  -#:    =:    *+    :=    :*-  :=:      -*",
  "   *=        :-     .  ::          .:  .     -:        =+",
  "   :#        .+.   :+      *:  :*      +:   .+:        #:",
  "    ++     :=:           . :.  .: .           :--     *+",
  "     ++   --      -=    .+.      .+.    -:      --   *+",
  "      -*- +   =:  .:       :    :       :.  .-   * -*-",
  "        -#:   -     ..     +.  .+     ..    .-   :#-",
  "        :* -     -=-=#+-   +    +   -*#=:=-     -.*.",
  "        =+.= -   .=:*#--# :      : #:=#+:=    - -:+=",
  "        -#  .=  .  ::::=%-        =#=::::  .  =.  #:",
  "         %.     =-       +        +       -+     .#",
  "         -#  +          .=        =.         .*  *-",
  "          ++ :    :     +.        .+     :.   . ++",
  "           ++    .+    =:          :=    =.    ++",
  "            -*:      .=:            :=.      :*-",
  "             .++    --  =: ..  .. --  =:    ++.",
  "               -*  --    +#+-::-+#+    =-  *-",
  "                *+:*:. .  :=*..*+. .  :-#.+*",
  "              ..:#.*-. . .   ==   . . .-#:%...",
  "               :.*:-*-       *+       -#--#..",
  "                 #=  -+::::------::::+=. -#",
  "                -#    *-..       ...=*    #:",
  "                =-     *.          .*     =+",
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

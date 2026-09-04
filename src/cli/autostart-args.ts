export interface AutostartEnableArgs {
  startNow: boolean;
}

/** Parse the deliberately small argument surface for `autostart enable`. */
export function parseAutostartEnableArgs(args: string[]): AutostartEnableArgs {
  let startNow = false;
  for (const arg of args) {
    if (arg !== '--now') throw new Error(`未知参数: ${arg}`);
    if (startNow) throw new Error(`重复参数: ${arg}`);
    startNow = true;
  }
  return { startNow };
}

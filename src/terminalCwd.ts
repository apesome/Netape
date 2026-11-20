/** Resolve a simple cd command without evaluating remote shell expressions. */
export function directoryAfterCd(command: string, cwd: string, home: string, previous = ""): string | null {
  // Read shell words, retaining quoted spaces and escaped characters.
  const words: string[] = [];
  let word = "", quote = "", escaped = false, started = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      else if (quote === '"' && /[$`]/.test(char)) return null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/[;&|<>$`*?()\n\r]/.test(char)) return null;
    if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else { word += char; started = true; }
  }
  if (quote || escaped) return null;
  if (started) words.push(word);
  if (words.shift() !== "cd") return null;
  if (words[0] === "--") words.shift();
  if (words.length > 1) return null;
  let path = words[0] ?? "~";
  if (!path) return null;
  if (path === "-") return previous || null;
  if (path === "~" || path.startsWith("~/")) path = home ? home + path.slice(1) : "";
  else if (path.startsWith("~") || path.startsWith("-")) return null;
  if (!path) return null;
  if (!path.startsWith("/")) {
    if (!cwd) return null;
    path = `${cwd}/${path}`;
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return "/" + segments.join("/");
}

/** Read commands from common prompts after readline completion/history edits. */
export function commandFromPrompt(line: string): string | null {
  return line.match(/^(?:\[[^\]]+\]|[^\s]+@[^\s]+[^$#>]*|[^$#>]+)[$#>]\s?(.*)$/)?.[1] ?? null;
}

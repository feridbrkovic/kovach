/**
 * What "allow for this session" covers for a terminal command.
 *
 * Remembering only the exact text makes the user approve `npx tsc --noEmit` and
 * then `npx tsc --noEmit 2>&1 | head -40` separately; remembering everything
 * would let text the model read later run anything. The middle: a command is
 * reduced to its scope (the program and what it is asked to do, e.g.
 * `npx expo lint`, `npm run test`, `git diff`), and a later command is covered
 * when every part of it has an allowed scope. Commands that fetch or run new
 * code, delete, publish or use shell features beyond a pipe into a filter have
 * no scope and are only ever remembered exactly.
 */

/** Read-only programs a result may be piped into. */
const FILTER = /^(head|tail|grep|wc|sort|uniq|cut|cat)(\s|$)/;
/** Runs a package: the scope names the package and its subcommand. */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Never widened beyond the exact command. */
const NEVER_PROGRAM = new Set([
  "rm", "rmdir", "sudo", "curl", "wget", "ssh", "scp", "rsync", "sh", "bash", "zsh", "eval", "exec", "osascript", "open",
  "kill", "killall", "pkill", "chmod", "chown", "dd", "launchctl", "defaults", "security", "mv", "cp", "ln", "tee", "xargs",
  "find", "sed", "awk", "perl", "docker", "kubectl", "gh", "aws", "gcloud", "eas", "fastlane",
]);
/** Packages that delete, deploy or copy in other people's code when run. */
const NEVER_PACKAGE = /^(rimraf|del-cli|trash-cli|eas-cli|vercel|netlify-cli|wrangler|firebase-tools|gh-pages|degit|tiged)(@|$)/;
const NEVER_ACTION = /^(publish|submit|push|deploy|login|logout|reset|clean|rebase|restore|checkout|switch|uninstall|remove|rm|unlink|prune|dlx|exec|build:dmg|release)$/;
const INSTALLS = /^(install|i|add|ci)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[\w./:@-]*$/;
const WORD = /^[\w@./:+-]+$/;
/** Shell features that make a command more than a list of simple parts. */
const SHELL = /[;`$<>\n\\()'"{}*?~!#]|\|\||(^|[^&])&($|[^&])/;

function scopeOfSimple(part: string): string | undefined {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && ENV_ASSIGNMENT.test(tokens[0]!)) tokens.shift();
  const program = tokens.shift();
  if (!program || !WORD.test(program) || NEVER_PROGRAM.has(program)) return undefined;
  if (!tokens.every((t) => t.startsWith("-") || WORD.test(t))) return undefined;
  const words = tokens.filter((t) => !t.startsWith("-"));

  if (RUNNERS.has(program)) {
    const [pkg, action] = words;
    if (!pkg || NEVER_PACKAGE.test(pkg)) return undefined;
    if (action && NEVER_ACTION.test(action)) return undefined;
    // `npx expo install <packages>` adds new code; with nothing to add it is a plain check.
    if (action && INSTALLS.test(action) && words.length > 2) return undefined;
    return [program, pkg, ...(action && /^[a-z][\w:-]*$/.test(action) ? [action] : [])].join(" ");
  }
  const [action, target] = words;
  if (action && NEVER_ACTION.test(action)) return undefined;
  if (MANAGERS.has(program)) {
    if (!action) return undefined;
    if (INSTALLS.test(action)) return words.length > 1 ? undefined : `${program} ${action}`;
    if (action === "run") return target && !NEVER_ACTION.test(target) ? `${program} run ${target}` : undefined;
    return `${program} ${action}`;
  }
  return action ? `${program} ${action}` : program;
}

/**
 * The scopes a command is made of, or undefined when it can only be remembered
 * exactly. `cd <folder> && …` and a pipe into a read-only filter are allowed around the parts.
 */
export function commandScopes(command: string): string[] | undefined {
  const plain = command.replace(/\s+2>&1/g, "").replace(/\s+2>\s*\/dev\/null/g, "");
  if (SHELL.test(plain)) return undefined;
  const scopes: string[] = [];
  for (const part of plain.split("&&")) {
    const [first, ...filters] = part.split("|").map((s) => s.trim());
    if (!first) return undefined;
    if (!filters.every((f) => FILTER.test(f))) return undefined;
    if (/^cd\s+[\w@./:+-]+$/.test(first) && filters.length === 0) continue;
    const scope = scopeOfSimple(first);
    if (!scope) return undefined;
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes.length > 0 ? scopes : undefined;
}

/** Shown on the button, so the user sees what a session-wide yes covers. */
export function scopeLabel(scopes: string[]): string {
  return scopes.map((s) => `${s} …`).join(" and ");
}

const key = (scope: string) => `scope:${scope}`;

export function rememberCommand(allowed: Set<string>, command: string): void {
  allowed.add(command);
  for (const s of commandScopes(command) ?? []) allowed.add(key(s));
}

export function commandAllowed(allowed: ReadonlySet<string> | undefined, command: string): boolean {
  if (!allowed) return false;
  if (allowed.has(command)) return true;
  const scopes = commandScopes(command);
  return scopes !== undefined && scopes.every((s) => allowed.has(key(s)));
}

import { invoke } from "@tauri-apps/api/core";

export interface ShortcutAction {
  id: string;
  label: string;
  defaultAccel: string;
}

/** Regroupement pour l'affichage ; l'ordre des ids suit celui des menus. */
export const SHORTCUT_GROUPS: Array<{ title: string; ids: string[] }> = [
  {
    title: "Onglets",
    ids: ["new-conn", "new-local", "close-tab", "next-tab", "prev-tab"],
  },
  { title: "Panneaux", ids: ["split-right", "split-down", "close-pane"] },
  { title: "Session", ids: ["reconnect", "toggle-files", "toggle-sync"] },
  { title: "Application", ids: ["settings"] },
];

/** Raccourcis non modifiables (gérés hors menu) ; `parts` est mis en forme comme les autres. */
export const FIXED_SHORTCUTS: Array<{ label: string; parts: string[]; sep?: string }> = [
  { label: "Aller à l'onglet 1 à 9", parts: ["CmdOrCtrl+1", "CmdOrCtrl+9"], sep: " … " },
  {
    label: "Copier / coller dans le terminal",
    parts: ["CmdOrCtrl+C", "CmdOrCtrl+V"],
    sep: " / ",
  },
  { label: "Quitter Cabestan", parts: ["CmdOrCtrl+Q"] },
];

export const shortcutActions = () => invoke<ShortcutAction[]>("shortcut_actions");

export const setShortcuts = (overrides: Record<string, string>) =>
  invoke<void>("set_shortcuts", { overrides });

/** Évaluée à l'appel (et non à l'import) pour rester testable. */
function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac/i.test(platform);
}

/** Affichage lisible d'un accélérateur Tauri ("CmdOrCtrl+Shift+D" → "⌘⇧D"). */
export function prettyAccel(accel: string): string {
  if (!accel) return "—";
  const MAC = isMac();
  const parts = accel.split("+");
  const key = parts.pop() ?? "";
  const mods = parts
    .map((m) => {
      const low = m.toLowerCase();
      if (low === "cmdorctrl" || low === "cmd" || low === "command" || low === "super")
        return MAC ? "⌘" : "Ctrl";
      if (low === "ctrl" || low === "control") return MAC ? "⌃" : "Ctrl";
      if (low === "shift") return MAC ? "⇧" : "Shift";
      if (low === "alt" || low === "option") return MAC ? "⌥" : "Alt";
      return m;
    })
    .join("");
  const prettyKey = key
    .replace(/^Comma$/i, ",")
    .replace(/^Tab$/i, "⇥")
    .replace(/^Space$/i, "␣")
    .replace(/^Enter|^Return$/i, "↩")
    .replace(/^Backspace$/i, "⌫")
    .replace(/^ArrowUp$/i, "↑")
    .replace(/^ArrowDown$/i, "↓")
    .replace(/^ArrowLeft$/i, "←")
    .replace(/^ArrowRight$/i, "→");
  return mods + prettyKey.toUpperCase();
}

/**
 * Convertit un évènement clavier en accélérateur Tauri.
 * Renvoie null si la combinaison n'est pas utilisable (touche morte, modificateur seul).
 */
export function accelFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push("CmdOrCtrl");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F[0-9]{1,2}$/.test(code)) key = code;
  else if (code === "Comma") key = "Comma";
  else if (code === "Period") key = "Period";
  else if (code === "Slash") key = "Slash";
  else if (code === "Minus") key = "Minus";
  else if (code === "Equal") key = "Equal";
  else if (code === "Tab") key = "Tab";
  else if (code === "Space") key = "Space";
  else if (code === "Enter") key = "Enter";
  else if (code === "Backspace") key = "Backspace";
  else if (code.startsWith("Arrow")) key = code;

  if (!key) return null;
  // Au moins un modificateur : sinon le raccourci volerait les frappes du terminal.
  if (mods.length === 0) return null;
  return [...mods, key].join("+");
}

/** ids partageant le même accélérateur (conflits à signaler). */
export function conflictsOf(
  actions: ShortcutAction[],
  overrides: Record<string, string>,
): Set<string> {
  const byAccel = new Map<string, string[]>();
  for (const a of actions) {
    const accel = overrides[a.id] ?? a.defaultAccel;
    if (!accel) continue;
    byAccel.set(accel, [...(byAccel.get(accel) ?? []), a.id]);
  }
  const out = new Set<string>();
  for (const ids of byAccel.values()) {
    if (ids.length > 1) ids.forEach((i) => out.add(i));
  }
  return out;
}

export interface Settings {
  termFontSize: number;
  termFontFamily: string;
  termCursorBlink: boolean;
  termScrollback: number;
  termTheme: string;
  hideHidden: boolean;
  filesDefault: boolean;
  syncDefault: boolean;
  /** Rouvrir les sessions de la dernière fois au démarrage. */
  restoreTabs: boolean;
  /** Retenter la connexion automatiquement quand une session tombe. */
  autoReconnect: boolean;
  /** Mettre à la corbeille du serveur au lieu de supprimer définitivement. */
  useTrash: boolean;
  /** Application d'édition ("" = app par défaut du système). */
  editorApp: string;
  /** Raccourcis personnalisés : id d'action → accélérateur ("" = retiré). */
  shortcuts: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  termFontSize: 13,
  termFontFamily: "JetBrains Mono",
  termCursorBlink: true,
  termScrollback: 8000,
  termTheme: "cabestan",
  hideHidden: false,
  filesDefault: true,
  syncDefault: false,
  restoreTabs: false,
  autoReconnect: true,
  useTrash: true,
  editorApp: "",
  shortcuts: {},
};

const KEY = "cabestan.settings";

export function loadSettings(): Settings {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    // Réglages enregistrés avant l'arrivée des raccourcis personnalisés.
    if (!s.shortcuts || typeof s.shortcuts !== "object") s.shortcuts = {};
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

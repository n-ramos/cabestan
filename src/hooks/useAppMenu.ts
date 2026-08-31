import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

export interface MenuActions {
  newConn: () => void;
  newLocal: () => void;
  closeTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  splitRight: () => void;
  splitDown: () => void;
  closePane: () => void;
  reconnect: () => void;
  settings: () => void;
  toggleFiles: () => void;
  toggleSync: () => void;
  docker: () => void;
  git: () => void;
}

/** Relie les évènements du menu natif aux actions de l'application. */
export function useAppMenu(actions: MenuActions) {
  useEffect(() => {
    let un: (() => void) | undefined;
    const map: Record<string, () => void> = {
      "new-conn": actions.newConn,
      "new-local": actions.newLocal,
      "close-tab": actions.closeTab,
      "next-tab": actions.nextTab,
      "prev-tab": actions.prevTab,
      "split-right": actions.splitRight,
      "split-down": actions.splitDown,
      "close-pane": actions.closePane,
      reconnect: actions.reconnect,
      settings: actions.settings,
      "toggle-files": actions.toggleFiles,
      "toggle-sync": actions.toggleSync,
      docker: actions.docker,
      git: actions.git,
    };
    listen<string>("menu", (e) => map[e.payload]?.()).then((u) => (un = u));
    return () => un?.();
    // Les actions sont des useCallback stables côté appelant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

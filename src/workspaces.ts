export interface Workspace {
  id: string;
  name: string;
  /** Connexions à rouvrir (ids du port d'attache). */
  connections: string[];
  /** Nombre d'onglets locaux à recréer. */
  locals: number;
}

const KEY = "cabestan.workspaces";

export function loadWorkspaces(): Workspace[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveWorkspaces(list: Workspace[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

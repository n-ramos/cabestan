import { SavedConnection } from "./api";

/** Couleurs considérées comme « sensible » : elles déclenchent les garde-fous. */
const SENSITIVE_COLORS = ["#e06c5a"];

/** Une connexion est-elle marquée comme sensible (prod) ? */
export function isSensitive(conn: SavedConnection | undefined): boolean {
  if (!conn) return false;
  if (conn.color && SENSITIVE_COLORS.includes(conn.color)) return true;
  // Comparaison sur des mots entiers, accents retirés : « préprod » et
  // « reproduction » ne doivent pas être pris pour de la production.
  const mots = `${conn.name} ${conn.group ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/);
  return mots.includes("prod") || mots.includes("production");
}

/** Actions interdites quand la session est en lecture seule. */
export type WriteAction =
  | "supprimer"
  | "renommer"
  | "droits"
  | "envoyer"
  | "créer"
  | "déplacer"
  | "écrire"
  | "extraire"
  | "archiver";

export const READ_ONLY_MESSAGE =
  "Session en lecture seule : cette action est bloquée. Levez le verrou dans la barre d'état.";

/**
 * Une suppression mérite-t-elle une confirmation renforcée ?
 * Oui sur une connexion sensible, dès qu'un dossier ou plusieurs éléments
 * sont concernés.
 */
export function needsStrongConfirm(
  sensitive: boolean,
  items: Array<{ isDir: boolean }>,
): boolean {
  if (!sensitive) return false;
  return items.length > 1 || items.some((i) => i.isDir);
}

/** Le texte saisi confirme-t-il l'action ? (comparaison tolérante aux espaces) */
export function confirmMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected.trim() && expected.trim() !== "";
}

export interface Window {
  /** Premier index rendu. */
  start: number;
  /** Dernier index rendu (exclu). */
  end: number;
  /** Hauteur du bloc d'espacement avant la fenêtre. */
  padTop: number;
  /** Hauteur du bloc d'espacement après la fenêtre. */
  padBottom: number;
}

/**
 * Calcule la tranche de lignes à rendre pour une liste défilante.
 * `overscan` ajoute une marge de part et d'autre pour éviter les trous
 * pendant un défilement rapide.
 */
export function visibleWindow(
  total: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  overscan = 8,
): Window {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const rawStart = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.max(0, rawStart - overscan);
  const end = Math.min(total, rawStart + visibleCount + overscan);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}

/** Au-delà de ce nombre de lignes, la virtualisation est activée. */
export const VIRTUAL_THRESHOLD = 200;

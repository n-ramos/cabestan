import { describe, expect, it } from "vitest";
import { visibleWindow } from "./virtual";

describe("fenêtre de rendu", () => {
  it("rend tout quand la liste est plus courte que l'écran", () => {
    const w = visibleWindow(5, 24, 600, 0);
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe(0);
  });

  it("limite le rendu à la zone visible plus la marge", () => {
    // 10 000 lignes de 24 px, écran de 480 px (20 lignes), en haut de liste.
    const w = visibleWindow(10000, 24, 480, 0, 8);
    expect(w.start).toBe(0);
    expect(w.end).toBe(28); // 20 visibles + 8 de marge
    expect(w.padBottom).toBe((10000 - 28) * 24);
  });

  it("suit le défilement", () => {
    const w = visibleWindow(10000, 24, 480, 24 * 100, 8);
    expect(w.start).toBe(92); // 100 - 8
    expect(w.end).toBe(128); // 100 + 20 + 8
    expect(w.padTop).toBe(92 * 24);
  });

  it("ne dépasse pas les bornes en fin de liste", () => {
    const w = visibleWindow(100, 24, 480, 24 * 95, 8);
    expect(w.end).toBe(100);
    expect(w.padBottom).toBe(0);
    expect(w.start).toBeLessThan(100);
  });

  it("reste sûre sur une liste vide ou une hauteur nulle", () => {
    expect(visibleWindow(0, 24, 480, 0)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
    });
    expect(visibleWindow(50, 0, 480, 0).end).toBe(0);
  });

  it("ignore un défilement négatif", () => {
    const w = visibleWindow(1000, 24, 480, -500);
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it("conserve la somme des hauteurs", () => {
    const total = 3000;
    const rowHeight = 24;
    const w = visibleWindow(total, rowHeight, 480, 24 * 500);
    const rendered = (w.end - w.start) * rowHeight;
    expect(w.padTop + rendered + w.padBottom).toBe(total * rowHeight);
  });
});

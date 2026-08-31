import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TreeView from "./TreeView";
import { toTree } from "../tree";

describe("arbre affiché", () => {
  it("montre les clés des deux premiers niveaux sans action", () => {
    render(<TreeView node={toTree({ services: { web: { image: "nginx" } } })} />);
    expect(screen.getByText("services")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
    // Le troisième niveau est replié par défaut.
    expect(screen.queryByText("image")).toBeNull();
  });

  it("déplie au clic", () => {
    render(<TreeView node={toTree({ services: { web: { image: "nginx" } } })} />);
    const boutons = screen.getAllByRole("button");
    fireEvent.click(boutons[boutons.length - 1]);
    expect(screen.getByText("image")).toBeTruthy();
    expect(screen.getByText("nginx")).toBeTruthy();
  });

  it("affiche les types avec leur classe", () => {
    render(<TreeView node={toTree({ port: 8080, actif: true, rien: null })} />);
    expect(screen.getByText("8080").className).toContain("nombre");
    expect(screen.getByText("vrai").className).toContain("booléen");
    expect(screen.getByText("null").className).toContain("vide");
  });
});

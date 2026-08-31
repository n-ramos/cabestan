import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DiffModal from "./DiffModal";

const lignes = (n: number) =>
  Array.from({ length: n }, (_, i) => `ligne ${i}`).join("\n");

const monter = (before: string, after: string) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <DiffModal
      path="/etc/nginx/nginx.conf"
      beforeLabel="version du serveur"
      before={before}
      afterLabel="votre version"
      after={after}
      confirmLabel="Écraser le serveur"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
};

describe("modale de diff", () => {
  it("affiche le chemin et le décompte des lignes touchées", () => {
    monter("a\nb\nc", "a\nB\nc\nd");
    expect(screen.getByText("/etc/nginx/nginx.conf")).toBeTruthy();
    expect(screen.getByText("− 1 retirée(s)")).toBeTruthy();
    expect(screen.getByText("+ 2 ajoutée(s)")).toBeTruthy();
  });

  it("nomme les deux versions comparées", () => {
    monter("a", "b");
    expect(screen.getByText("− version du serveur · + votre version")).toBeTruthy();
  });

  it("replie les longues plages identiques et sait les déplier", () => {
    monter(lignes(30), lignes(30).replace("ligne 15", "MODIFIÉE"));
    // Deux replis : avant et après la ligne modifiée.
    expect(screen.getAllByText(/lignes identiques/)).toHaveLength(2);
    const bouton = screen.getByText(/Afficher les \d+ lignes repliées/);
    fireEvent.click(bouton);
    expect(screen.queryByText(/lignes identiques/)).toBeNull();
    expect(screen.queryByText(/lignes repliées/)).toBeNull();
  });

  it("montre la ligne retirée et la ligne ajoutée", () => {
    monter("listen 80;", "listen 443 ssl;");
    expect(screen.getByText("listen 80;")).toBeTruthy();
    expect(screen.getByText("listen 443 ssl;")).toBeTruthy();
  });

  it("remonte la confirmation et l'annulation", () => {
    const { onConfirm, onCancel } = monter("a", "b");
    fireEvent.click(screen.getByText("Écraser le serveur"));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Annuler"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("n'annule pas sur un clic dans la modale, mais bien sur le fond", () => {
    const { onCancel } = monter("a", "b");
    fireEvent.mouseDown(screen.getByText("Différences"));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

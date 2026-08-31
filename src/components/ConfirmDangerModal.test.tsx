import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConfirmDangerModal from "./ConfirmDangerModal";

const setup = (over: Partial<Parameters<typeof ConfirmDangerModal>[0]> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDangerModal
      expected="Prod web"
      action="Suppression définitive"
      details="2 éléments sur Prod web."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onConfirm, onCancel };
};

describe("confirmation renforcée", () => {
  it("annonce l'action et le détail", () => {
    setup();
    expect(screen.getByText("Suppression définitive")).toBeTruthy();
    expect(screen.getByText("2 éléments sur Prod web.")).toBeTruthy();
  });

  it("garde le bouton désactivé tant que le nom n'est pas exact", () => {
    setup();
    const bouton = screen.getByRole("button", { name: "Confirmer" }) as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Prod web"), {
      target: { value: "prod web" },
    });
    expect(bouton.disabled).toBe(true);
  });

  it("active la confirmation quand le nom correspond", () => {
    const { onConfirm } = setup();
    fireEvent.change(screen.getByPlaceholderText("Prod web"), {
      target: { value: "Prod web" },
    });
    const bouton = screen.getByRole("button", { name: "Confirmer" }) as HTMLButtonElement;
    expect(bouton.disabled).toBe(false);
    fireEvent.click(bouton);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("n'appelle jamais la confirmation sur annulation", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

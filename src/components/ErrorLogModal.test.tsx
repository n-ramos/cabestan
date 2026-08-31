import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ErrorLogModal from "./ErrorLogModal";

describe("journal d'erreurs", () => {
  it("annonce l'absence d'erreur", () => {
    render(<ErrorLogModal errors={[]} onClear={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Aucune erreur enregistrée.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Vider/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("affiche les erreurs, la plus récente en tête", () => {
    render(
      <ErrorLogModal
        errors={[
          { id: "1", at: Date.parse("2026-08-27T10:00:00"), text: "première panne" },
          { id: "2", at: Date.parse("2026-08-27T11:00:00"), text: "seconde panne" },
        ]}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const textes = screen.getAllByText(/panne/).map((e) => e.textContent);
    expect(textes[0]).toBe("seconde panne");
    expect(textes[1]).toBe("première panne");
  });

  it("propage le vidage", () => {
    const onClear = vi.fn();
    render(
      <ErrorLogModal
        errors={[{ id: "1", at: Date.now(), text: "panne" }]}
        onClear={onClear}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Vider/ }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

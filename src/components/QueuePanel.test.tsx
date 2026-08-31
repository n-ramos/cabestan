import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import QueuePanel from "./QueuePanel";
import { Job, makeJob } from "../queue";

const job = (state: Job["state"], name = "a.txt", attempts = 0): Job => ({
  ...makeJob("upload", "s0", `/local/${name}`, `/remote/${name}`),
  state,
  attempts,
});

const setup = (jobs: Job[], paused = false) => {
  const props = {
    jobs,
    paused,
    concurrency: 2,
    onPause: vi.fn(),
    onConcurrency: vi.fn(),
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
  };
  render(<QueuePanel {...props} />);
  return props;
};

describe("panneau de file", () => {
  it("résume l'état dans le titre", () => {
    setup([job("en cours"), job("attente", "b.txt"), job("échec", "c.txt")]);
    expect(screen.getByText(/1 en cours/)).toBeTruthy();
    expect(screen.getByText(/1 en attente/)).toBeTruthy();
    expect(screen.getByText(/1 en échec/)).toBeTruthy();
  });

  it("propose la pause, puis la reprise", () => {
    const p = setup([job("attente")]);
    fireEvent.click(screen.getByRole("button", { name: /Mettre en pause/ }));
    expect(p.onPause).toHaveBeenCalledWith(true);
  });

  it("affiche « Reprendre » quand la file est en pause", () => {
    setup([job("attente")], true);
    expect(screen.getByRole("button", { name: /Reprendre/ })).toBeTruthy();
    expect(screen.getByText(/File en pause/)).toBeTruthy();
  });

  it("propose la reprise seulement sur un échec sous le plafond", () => {
    const p = setup([job("échec", "a.txt", 1)]);
    const boutons = screen.getAllByTitle("Reprendre ce transfert");
    expect(boutons).toHaveLength(1);
    fireEvent.click(boutons[0]);
    expect(p.onRetry).toHaveBeenCalledOnce();
  });

  it("ne propose pas la reprise au-delà du plafond", () => {
    setup([job("échec", "a.txt", 3)]);
    expect(screen.queryAllByTitle("Reprendre ce transfert")).toHaveLength(0);
  });

  it("propose l'annulation d'un transfert en cours", () => {
    const p = setup([job("en cours")]);
    fireEvent.click(screen.getByTitle("Annuler ce transfert"));
    expect(p.onCancel).toHaveBeenCalledOnce();
  });

  it("annonce une file vide", () => {
    setup([]);
    expect(screen.getByText("Aucun transfert en file.")).toBeTruthy();
  });
});

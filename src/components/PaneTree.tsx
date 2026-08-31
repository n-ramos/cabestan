import { ReactNode, useRef } from "react";
import { PaneNode } from "../panes";

interface Props {
  node: PaneNode;
  path?: string;
  onRatio: (path: string, ratio: number) => void;
  renderLeaf: (paneId: string) => ReactNode;
}

/** Rendu récursif de l'arbre de panneaux, avec séparateurs ajustables. */
export default function PaneTree({ node, path = "", onRatio, renderLeaf }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  if (node.type === "leaf") {
    return <div className="pane-leaf">{renderLeaf(node.paneId)}</div>;
  }

  const horizontal = node.dir === "row"; // côte à côte

  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (ev: PointerEvent) => {
      const ratio = horizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      onRatio(path, Math.min(0.85, Math.max(0.15, ratio)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={containerRef}
      className={`pane-split ${horizontal ? "h" : "v"}`}
      style={{ flexDirection: horizontal ? "row" : "column" }}
    >
      <div className="pane-cell" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <PaneTree
          node={node.a}
          path={path + "a"}
          onRatio={onRatio}
          renderLeaf={renderLeaf}
        />
      </div>
      <div
        className={`pane-divider ${horizontal ? "h" : "v"}`}
        onPointerDown={onDividerDown}
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
      />
      <div className="pane-cell grow">
        <PaneTree
          node={node.b}
          path={path + "b"}
          onRatio={onRatio}
          renderLeaf={renderLeaf}
        />
      </div>
    </div>
  );
}

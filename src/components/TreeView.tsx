import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { TreeNode } from "../tree";

function Node({ node, depth }: { node: TreeNode; depth: number }) {
  // Les deux premiers niveaux sont ouverts d'emblée : on voit la structure
  // sans tout déplier à la main.
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = !!node.children?.length;

  return (
    <div className="tv-node" style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      <div className="tv-row">
        {hasChildren ? (
          <button className="tv-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="tv-toggle" />
        )}
        <span className="tv-key">{node.key}</span>
        {node.value !== undefined && (
          <span className={`tv-value ${node.type}`}>{node.value}</span>
        )}
      </div>
      {open &&
        node.children?.map((c, i) => (
          <Node key={`${c.key}-${i}`} node={c} depth={depth + 1} />
        ))}
    </div>
  );
}

export default function TreeView({ node }: { node: TreeNode }) {
  return (
    <div className="tv-root">
      <Node node={node} depth={0} />
    </div>
  );
}

import { useCallback } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const initialNodes: Node[] = [
  { id: "1", position: { x: 50, y: 100 }, data: { label: "DRAM" }, style: { background: "#1f2937", color: "#60a5fa", border: "1px solid #374151" } },
  { id: "2", position: { x: 250, y: 100 }, data: { label: "L2 / BRAM" }, style: { background: "#1f2937", color: "#34d399", border: "1px solid #374151" } },
  { id: "3", position: { x: 450, y: 100 }, data: { label: "MAC Array" }, style: { background: "#1f2937", color: "#a78bfa", border: "1px solid #374151" } },
];

const initialEdges: Edge[] = [
  { id: "e1-2", source: "1", target: "2", animated: true, style: { stroke: "#60a5fa" } },
  { id: "e2-3", source: "2", target: "3", animated: true, style: { stroke: "#34d399" } },
];

export function NodeEditor() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        colorMode="dark"
        fitView
      >
        <Controls />
        <MiniMap nodeStrokeWidth={3} />
        <Background gap={12} size={1} />
      </ReactFlow>
    </div>
  );
}

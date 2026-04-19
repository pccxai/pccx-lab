import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CanvasView } from "./CanvasView";
import { PerfChart } from "./PerfChart";
import { NodeEditor } from "./NodeEditor";
import { Flex, Text, Button, TextField } from "@radix-ui/themes";
import { Cpu, LayoutDashboard, BrainCircuit, Activity } from "lucide-react";

function App() {
  const [header, setHeader] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"canvas" | "nodes">("canvas");

  useEffect(() => {
    async function loadTrace() {
      try {
        const res = await invoke("load_pccx", { path: "../../dummy_trace.pccx" });
        setHeader(res);
        console.log("Loaded header:", res);
      } catch (err) {
        console.error("Failed to load trace", err);
      }
    }
    loadTrace();
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-950 text-gray-100 overflow-hidden select-none font-sans">
      {/* Title Bar (Native Drag Region) */}
      <div 
        className="h-10 border-b border-gray-800/50 bg-gray-950/80 flex items-center justify-between px-4"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2 pointer-events-none">
          <Cpu size={16} className="text-blue-500" />
          <span className="text-xs font-semibold tracking-wide text-gray-300">pccx-lab</span>
        </div>
        <div className="text-[10px] text-gray-500 pointer-events-none">v0.2.0 (Tauri)</div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Activity Bar (Sidebar Icons) */}
        <div className="w-12 border-r border-gray-800/50 bg-gray-900/50 flex flex-col items-center py-4 gap-6">
          <button className="p-2 rounded-md hover:bg-gray-800 text-blue-400 transition-colors"><LayoutDashboard size={20} /></button>
          <button className="p-2 rounded-md hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"><Activity size={20} /></button>
          <button className="p-2 rounded-md hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"><BrainCircuit size={20} /></button>
        </div>

        {/* Layout */}
        <div className="flex-1 flex">
          {/* Main Area */}
          <div className="flex-[7] flex flex-col relative">
            <div className="h-8 border-b border-gray-800/50 bg-gray-900/30 flex items-center px-3 gap-4 text-xs font-medium text-gray-400">
              <button 
                onClick={() => setActiveTab("canvas")}
                className={`hover:text-gray-200 transition-colors ${activeTab === "canvas" ? "text-blue-400 border-b-2 border-blue-400 h-full" : ""}`}
              >
                MAC Array 3D
              </button>
              <button 
                onClick={() => setActiveTab("nodes")}
                className={`hover:text-gray-200 transition-colors ${activeTab === "nodes" ? "text-blue-400 border-b-2 border-blue-400 h-full" : ""}`}
              >
                Data Flow Graph
              </button>
            </div>
            
            <div className="flex-1 relative bg-gradient-to-br from-gray-950 to-gray-900">
              {activeTab === "canvas" ? <CanvasView /> : <NodeEditor />}
              
              {/* Overlay Info (Only for Canvas) */}
              {activeTab === "canvas" && (
                <div className="absolute top-4 left-4 bg-gray-900/60 backdrop-blur-md border border-gray-700/50 p-3 rounded-lg pointer-events-none">
                  <Text size="2" weight="bold" className="text-blue-400 block mb-1">Systolic Array Status</Text>
                  <div className="flex justify-between gap-4 text-xs">
                    <span className="text-gray-400">Trace Cycles:</span>
                    <span className="text-gray-200">{header?.trace?.cycles || "Loading..."}</span>
                  </div>
                  <div className="flex justify-between gap-4 text-xs">
                    <span className="text-gray-400">Encoding:</span>
                    <span className="text-gray-200">{header?.payload?.encoding || "Loading..."}</span>
                  </div>
                </div>
              )}
            </div>
            
            {/* Bottom Panel (Charts) */}
            <div className="h-[250px] border-t border-gray-800/50 bg-gray-950 flex flex-col">
              <div className="h-8 border-b border-gray-800/50 bg-gray-900/30 flex items-center px-3 text-xs font-medium text-gray-400">
                Timeline & Profiling
              </div>
              <div className="flex-1 p-2">
                <PerfChart />
              </div>
            </div>
          </div>

          {/* Resize Handle (Mock) */}
          <div className="w-1 bg-gray-800/50" />

          {/* AI Copilot Panel */}
          <div className="flex-[3] bg-gray-900/30 flex flex-col">
            <div className="h-8 border-b border-gray-800/50 bg-gray-900/30 flex items-center px-3 text-xs font-medium text-gray-400 gap-2">
              <BrainCircuit size={14} className="text-purple-400" /> AI Copilot
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-4 text-sm">
              <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg p-3">
                <Text size="2" className="text-gray-300">
                  <strong className="text-blue-400">System:</strong> Trace analysis complete. 
                  Found a DMA bandwidth bottleneck during Layer2_Attention calculation.
                </Text>
              </div>
              <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-3 ml-4">
                <Text size="2" className="text-blue-200">
                  How can I optimize the memory fetch for this layer?
                </Text>
              </div>
              <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg p-3 mr-4">
                <Text size="2" className="text-gray-300">
                  <strong className="text-purple-400">AI:</strong> Try increasing the L2 prefetch depth. I can generate a UVM testbench sequence to verify this.
                </Text>
                <div className="mt-2 pt-2 border-t border-gray-700/50">
                  <Button size="1" variant="soft" color="purple">Generate SV Sequence</Button>
                </div>
              </div>
            </div>

            {/* Input Area */}
            <div className="p-3 border-t border-gray-800/50 bg-gray-950">
              <Flex gap="2">
                <TextField.Root placeholder="Ask the architecture copilot..." className="flex-1 bg-gray-900/50 border-gray-700/50" />
                <Button variant="solid" color="blue">Send</Button>
              </Flex>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

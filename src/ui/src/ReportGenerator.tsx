import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Dialog, Flex } from "@radix-ui/themes";
import { FileText, Download } from "lucide-react";

export function ReportGenerator() {
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      // Dummy snapshot logic
      const message = await invoke("generate_report");
      alert(message);
    } catch (err) {
      console.error(err);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <button className="p-2 rounded-md hover:bg-gray-800 text-purple-400 transition-colors" title="Export PDF Report">
          <FileText size={20} />
        </button>
      </Dialog.Trigger>
      <Dialog.Content style={{ maxWidth: 450, backgroundColor: "#111827", color: "#f3f4f6", border: "1px solid #374151" }}>
        <Dialog.Title>Generate Report</Dialog.Title>
        <Dialog.Description size="2" mb="4" color="gray">
          Compile the current 32K 3D trace snapshots, node layouts, and AI Copilot analysis into a professional PDF report.
        </Dialog.Description>

        <Flex direction="column" gap="3">
          <div className="bg-gray-900 border border-gray-800 p-4 rounded-md">
            <ul className="list-disc pl-5 text-sm text-gray-300">
              <li>High-res Instanced MAC Array Snapshots</li>
              <li>Data Flow Configuration Graph</li>
              <li>L2 Prefetch Optimization AI Summary</li>
            </ul>
          </div>
        </Flex>

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Cancel
            </Button>
          </Dialog.Close>
          <Dialog.Close>
            <Button variant="solid" color="purple" onClick={handleGenerate} disabled={generating}>
              <Download size={16} /> {generating ? "Generating..." : "Export PDF"}
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

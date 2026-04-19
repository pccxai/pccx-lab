import ReactECharts from "echarts-for-react";

export function PerfChart() {
  const options = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" },
    grid: { top: 30, right: 20, bottom: 30, left: 50 },
    xAxis: {
      type: "category",
      data: ["0ms", "10ms", "20ms", "30ms", "40ms", "50ms", "60ms"],
      axisLabel: { color: "#9ca3af" }
    },
    yAxis: {
      type: "value",
      name: "Util %",
      nameTextStyle: { color: "#9ca3af" },
      axisLabel: { color: "#9ca3af" }
    },
    series: [
      {
        name: "MAC Array",
        data: [10, 40, 85, 90, 60, 20, 15],
        type: "line",
        smooth: true,
        lineStyle: { width: 3, color: "#3b82f6" },
        areaStyle: {
          color: {
            type: "linear",
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(59, 130, 246, 0.5)" },
              { offset: 1, color: "rgba(59, 130, 246, 0)" }
            ]
          }
        }
      },
      {
        name: "DRAM Bandwidth",
        data: [80, 70, 30, 20, 50, 90, 95],
        type: "line",
        smooth: true,
        lineStyle: { width: 3, color: "#10b981" }
      }
    ]
  };

  return <ReactECharts option={options} style={{ height: "100%", width: "100%" }} />;
}

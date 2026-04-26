import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight, ChevronDown, Code2, FileText, Folder,
  Cog, FileCode2, Cpu, Binary, Braces, Hash, Terminal,
} from "lucide-react";
import { useTheme } from "./ThemeContext";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[] | null;
}

interface FileTreeProps {
  root: string;
  onFileOpen: (path: string, name: string) => void;
}

// ─── Extension icon mapping ─────────────────────────────────────────────────

type IconKind = "hdl" | "cx" | "rust" | "toml" | "json" | "c_cpp" | "python" | "shell" | "config" | "generic";

const EXT_MAP: Record<string, IconKind> = {
  sv: "hdl", svh: "hdl", v: "hdl", vh: "hdl", vhd: "hdl", vhdl: "hdl",
  cx: "cx",
  rs: "rust",
  toml: "toml", yaml: "config", yml: "config",
  json: "json", jsonc: "json",
  c: "c_cpp", cpp: "c_cpp", h: "c_cpp", hpp: "c_cpp",
  py: "python",
  sh: "shell", bash: "shell", zsh: "shell",
  mk: "config", makefile: "config",
};

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function iconKind(name: string): IconKind {
  const lower = name.toLowerCase();
  if (lower === "makefile" || lower === "justfile") return "config";
  return EXT_MAP[extOf(name)] ?? "generic";
}

interface FileIconProps { kind: IconKind; accent: string; muted: string; size?: number }

function FileIcon({ kind, accent, muted, size = 14 }: FileIconProps) {
  switch (kind) {
    case "hdl":    return <Code2 size={size} color={accent} />;
    case "cx":     return <Cpu size={size} color="#e5a400" />;
    case "rust":   return <Cog size={size} color="#dea584" />;
    case "toml":   return <Braces size={size} color="#9cdcfe" />;
    case "json":   return <Braces size={size} color="#ce9178" />;
    case "c_cpp":  return <FileCode2 size={size} color="#519aba" />;
    case "python": return <Hash size={size} color="#4ec86b" />;
    case "shell":  return <Terminal size={size} color={muted} />;
    case "config": return <Binary size={size} color={muted} />;
    default:       return <FileText size={size} color={muted} />;
  }
}

// ─── Flatten tree for virtual rendering ─────────────────────────────────────

interface FlatNode {
  node: FileNode;
  depth: number;
}

function flattenTree(
  nodes: FileNode[],
  expanded: Set<string>,
  depth: number = 0,
): FlatNode[] {
  const result: FlatNode[] = [];
  for (const node of nodes) {
    result.push({ node, depth });
    if (node.is_dir && expanded.has(node.path) && node.children?.length) {
      result.push(...flattenTree(node.children, expanded, depth + 1));
    }
  }
  return result;
}

// ─── Row (memoized) ─────────────────────────────────────────────────────────

interface RowProps {
  node: FileNode;
  depth: number;
  isOpen: boolean;
  isFocused: boolean;
  onToggle: (path: string, isDir: boolean) => void;
  onFileOpen: (path: string, name: string) => void;
  onFocus: (path: string) => void;
}

const ROW_HEIGHT = 22;

const Row = memo(function Row({
  node,
  depth,
  isOpen,
  isFocused,
  onToggle,
  onFileOpen,
  onFocus,
}: RowProps) {
  const { accent, text, textMuted, bgHover, accentBg } = useTheme();
  const kind = iconKind(node.name);
  const isHdl = kind === "hdl";

  const handleClick = useCallback(() => {
    onFocus(node.path);
    if (node.is_dir) {
      onToggle(node.path, true);
    }
  }, [node.path, node.is_dir, onToggle, onFocus]);

  const handleDoubleClick = useCallback(() => {
    if (!node.is_dir) {
      onFileOpen(node.path, node.name);
    }
  }, [node.path, node.name, node.is_dir, onFileOpen]);

  return (
    <div
      role="treeitem"
      aria-expanded={node.is_dir ? isOpen : undefined}
      aria-selected={isFocused}
      data-path={node.path}
      style={{
        display: "flex",
        alignItems: "center",
        height: ROW_HEIGHT,
        paddingLeft: depth * 16 + 4,
        cursor: node.is_dir ? "pointer" : "default",
        userSelect: "none",
        color: isHdl ? accent : text,
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        background: isFocused ? accentBg : "transparent",
        borderLeft: isFocused ? `2px solid ${accent}` : `2px solid transparent`,
        outline: "none",
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={(e) => {
        if (!isFocused) (e.currentTarget as HTMLElement).style.backgroundColor = bgHover;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = isFocused ? accentBg : "transparent";
      }}
    >
      {/* Chevron */}
      <span style={{ width: 16, flexShrink: 0, display: "inline-flex" }}>
        {node.is_dir ? (
          isOpen ? <ChevronDown size={14} color={textMuted} /> : <ChevronRight size={14} color={textMuted} />
        ) : null}
      </span>

      {/* Icon */}
      <span style={{ width: 16, flexShrink: 0, display: "inline-flex", marginRight: 4 }}>
        {node.is_dir ? (
          <Folder size={14} color={isOpen ? accent : textMuted} />
        ) : (
          <FileIcon kind={kind} accent={accent} muted={textMuted} />
        )}
      </span>

      {/* Name */}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {node.name}
      </span>
    </div>
  );
});

// ─── FileTree ────────────────────────────────────────────────────────────────

export default function FileTree({ root, onFileOpen }: FileTreeProps) {
  const theme = useTheme();
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Virtual scroll state
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Flatten visible tree
  const flatList = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);

  // Virtual window: render only visible rows + buffer
  const OVERSCAN = 10;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(flatList.length, startIdx + visibleCount);
  const visibleSlice = flatList.slice(startIdx, endIdx);
  const totalHeight = flatList.length * ROW_HEIGHT;

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    invoke<FileNode[]>("read_file_tree", { root, depth: 1 })
      .then((tree) => {
        if (!cancelled) {
          setNodes(tree);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => { cancelled = true; };
  }, [root]);

  const handleToggle = useCallback(
    (path: string, isDir: boolean) => {
      if (!isDir) return;

      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });

      // Lazy fetch children if not yet loaded
      setNodes((prev) => {
        const needsFetch = (list: FileNode[]): boolean => {
          for (const n of list) {
            if (n.path === path) return !!(n.children && n.children.length === 0);
            if (n.children && needsFetch(n.children)) return true;
          }
          return false;
        };

        if (needsFetch(prev)) {
          invoke<FileNode[]>("read_file_tree", { root: path, depth: 1 }).then((children) => {
            const attach = (list: FileNode[]): FileNode[] =>
              list.map((n) =>
                n.path === path
                  ? { ...n, children }
                  : n.children
                    ? { ...n, children: attach(n.children) }
                    : n
              );
            setNodes((cur) => attach(cur));
          });
        }
        return prev;
      });
    },
    [],
  );

  const handleFocus = useCallback((path: string) => {
    setFocusedPath(path);
    containerRef.current?.focus();
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatList.length === 0) return;

      const focusIdx = flatList.findIndex((f) => f.node.path === focusedPath);
      let idx = focusIdx >= 0 ? focusIdx : 0;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          idx = Math.min(idx + 1, flatList.length - 1);
          setFocusedPath(flatList[idx].node.path);
          // Scroll into view
          const rowBottom = (idx + 1) * ROW_HEIGHT;
          if (rowBottom > scrollTop + containerHeight) {
            containerRef.current?.scrollTo({ top: rowBottom - containerHeight });
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          idx = Math.max(idx - 1, 0);
          setFocusedPath(flatList[idx].node.path);
          const rowTop = idx * ROW_HEIGHT;
          if (rowTop < scrollTop) {
            containerRef.current?.scrollTo({ top: rowTop });
          }
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const f = flatList[idx];
          if (f.node.is_dir && !expanded.has(f.node.path)) {
            handleToggle(f.node.path, true);
          } else if (f.node.is_dir && expanded.has(f.node.path) && f.node.children?.length) {
            // Move focus to first child
            if (idx + 1 < flatList.length) {
              setFocusedPath(flatList[idx + 1].node.path);
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const fl = flatList[idx];
          if (fl.node.is_dir && expanded.has(fl.node.path)) {
            handleToggle(fl.node.path, true);
          } else if (fl.depth > 0) {
            // Move focus to parent directory
            for (let i = idx - 1; i >= 0; i--) {
              if (flatList[i].depth < fl.depth && flatList[i].node.is_dir) {
                setFocusedPath(flatList[i].node.path);
                break;
              }
            }
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          const fe = flatList[idx];
          if (fe.node.is_dir) {
            handleToggle(fe.node.path, true);
          } else {
            onFileOpen(fe.node.path, fe.node.name);
          }
          break;
        }
        default:
          return;
      }
    },
    [flatList, focusedPath, expanded, scrollTop, containerHeight, handleToggle, onFileOpen],
  );

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  if (error) {
    return (
      <div style={{ padding: 8, fontSize: 11, color: theme.error, fontFamily: "'JetBrains Mono', monospace" }}>
        {error}
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div style={{ padding: 8, fontSize: 11, color: theme.textFaint, fontFamily: "'JetBrains Mono', monospace" }}>
        Empty directory
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="tree"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      style={{
        overflowY: "auto",
        overflowX: "hidden",
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        height: "100%",
        outline: "none",
        position: "relative",
      }}
    >
      {/* Virtual spacer */}
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ position: "absolute", top: startIdx * ROW_HEIGHT, left: 0, right: 0 }}>
          {visibleSlice.map(({ node, depth }) => (
            <Row
              key={node.path}
              node={node}
              depth={depth}
              isOpen={expanded.has(node.path)}
              isFocused={node.path === focusedPath}
              onToggle={handleToggle}
              onFileOpen={onFileOpen}
              onFocus={handleFocus}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

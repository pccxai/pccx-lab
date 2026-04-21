import { useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";

// Event type IDs must match core/src/trace.rs event_type_id module
const TYPE_MAC_COMPUTE    = 1;
const TYPE_DMA_READ       = 2;
const TYPE_DMA_WRITE      = 3;
const TYPE_SYSTOLIC_STALL = 4;
const TYPE_BARRIER_SYNC   = 5;

// MAC array dimensions — must match HardwareModel::pccx_reference()
const ROWS = 32;
const COLS = 32;
const COUNT = ROWS * COLS;

/** Maps [0,1] utilisation to an HSL colour (blue=idle → green=active → red=hot). */
function utilToColor(util: number): THREE.Color {
  // cold: hue=220 (blue) → warm: hue=120 (green) → hot: hue=0 (red)
  const hue = (1.0 - util) * 220;
  return new THREE.Color().setHSL(hue / 360, 0.9, 0.55);
}

// Round-5 T-3: `animated` gates the ornamental colour pulse wave.
// When false (e.g. paused playback) the array renders static per-core
// utilisation only — no decorative heartbeat.  Default true preserves
// the existing <CanvasView /> call sites.
interface CanvasViewProps { animated?: boolean; isPlaying?: boolean }

export function CanvasView({ animated = true, isPlaying }: CanvasViewProps = {}) {
  // `isPlaying` is the canonical name; `animated` is the prop alias
  // the ticket calls out.  Treat either as the animation gate.
  const animationEnabled = isPlaying ?? animated;
  const animRef = useRef<boolean>(animationEnabled);
  animRef.current = animationEnabled;
  const mountRef  = useRef<HTMLDivElement>(null);
  const animIdRef = useRef<number>(0);

  // Mouse state for orbit-like rotation
  const mouse = useRef({ dragging: false, lastX: 0, lastY: 0, rotX: 0.3, rotY: 0.4 });

  const setupMouseHandlers = useCallback((
    canvas: HTMLCanvasElement,
    mesh: THREE.InstancedMesh,
    camera: THREE.PerspectiveCamera,
  ) => {
    const m = mouse.current;

    const onDown = (e: MouseEvent) => {
      m.dragging = true; m.lastX = e.clientX; m.lastY = e.clientY;
    };
    const onUp   = () => { m.dragging = false; };
    const onMove = (e: MouseEvent) => {
      if (!m.dragging) return;
      const dx = e.clientX - m.lastX;
      const dy = e.clientY - m.lastY;
      m.lastX = e.clientX; m.lastY = e.clientY;
      m.rotY += dx * 0.005;
      m.rotX += dy * 0.005;
      m.rotX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, m.rotX));
      mesh.rotation.y = m.rotY;
      mesh.rotation.x = m.rotX;
    };
    const onWheel = (e: WheelEvent) => {
      camera.position.z = Math.max(10, Math.min(60, camera.position.z + e.deltaY * 0.03));
    };

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);
    canvas.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const w = container.clientWidth;
    const h = container.clientHeight;

    // ─── Scene Setup ────────────────────────────────────────────────
    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
    camera.position.set(0, 0, 28);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // ─── Instanced MAC Array ────────────────────────────────────────
    const geo  = new THREE.BoxGeometry(0.78, 0.78, 0.78);
    const mat  = new THREE.MeshStandardMaterial({
      roughness: 0.25,
      metalness: 0.85,
      vertexColors: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dummy = new THREE.Object3D();
    let   idx   = 0;
    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) {
        dummy.position.set(x - COLS / 2 + 0.5, y - ROWS / 2 + 0.5, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
        mesh.setColorAt(idx, utilToColor(0.15)); // start as "cold"
        idx++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mouse.current.rotX = 0.3;
    mouse.current.rotY = 0.4;
    mesh.rotation.x = mouse.current.rotX;
    mesh.rotation.y = mouse.current.rotY;
    scene.add(mesh);

    // ─── Lights ─────────────────────────────────────────────────────
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
    dirLight.position.set(12, 12, 15);
    scene.add(dirLight);
    scene.add(new THREE.AmbientLight(0x404060, 1.8));
    const rimLight = new THREE.DirectionalLight(0x6060ff, 0.8);
    rimLight.position.set(-10, -8, -5);
    scene.add(rimLight);

    // ─── Grid Helper (floor reference) ──────────────────────────────
    const grid = new THREE.GridHelper(COLS, COLS, 0x1a1a2e, 0x1a1a2e);
    grid.position.y = -(ROWS / 2) - 1;
    scene.add(grid);

    // ─── Load live utilisation data ─────────────────────────────────
    invoke<{ core_utils: { core_id: number; util_pct: number }[] }>(
      "get_core_utilisation"
    )
      .then(({ core_utils }) => {
        const utilMap = new Map(core_utils.map((c) => [c.core_id, c.util_pct / 100]));
        let i2 = 0;
        for (let x = 0; x < COLS; x++) {
          for (let y = 0; y < ROWS; y++) {
            // Map 2-D position → core_id (row-major)
            const coreId = y * COLS + x;
            const util   = utilMap.get(coreId % core_utils.length) ?? 0.15;
            mesh.setColorAt(i2, utilToColor(util));
            i2++;
          }
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      })
      .catch(() => {
        // Keep "cold" colours if no trace is loaded
      });

    // ─── Pulsing animation: simulate live MAC activity ───────────────
    let phase = 0;
    const animate = () => {
      animIdRef.current = requestAnimationFrame(animate);
      phase += 0.018;

      // Slow auto-rotate when not dragging
      if (!mouse.current.dragging) {
        mouse.current.rotY += 0.0008;
        mesh.rotation.y = mouse.current.rotY;
      }

      if (animRef.current) {
        // Ornamental — W3C WAAPI pattern 3.  Not a data source; the
        // `animated` prop guards this branch so a paused player
        // shows a static array instead of a decorative heartbeat.
        // Travelling "wave" of activity across the array columns.
        let wi = 0;
        for (let x = 0; x < COLS; x++) {
          const wave = 0.5 + 0.5 * Math.sin(phase * 2 - x * 0.4);
          for (let y = 0; y < ROWS; y++) {
            // Combine per-core utilisation (baked) with wave animation
            // We re-read the baked color and mix with wave
            const col = new THREE.Color();
            mesh.getColorAt(wi, col);
            // Lerp brightness with wave
            col.multiplyScalar(0.85 + 0.15 * wave);
            mesh.setColorAt(wi, col);
            wi++;
          }
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      renderer.render(scene, camera);
    };
    animate();

    // ─── Mouse controls ──────────────────────────────────────────────
    const removeMouseHandlers = setupMouseHandlers(renderer.domElement, mesh, camera);

    // ─── Resize handler ──────────────────────────────────────────────
    const onResize = () => {
      if (!container) return;
      const nw = container.clientWidth;
      const nh = container.clientHeight;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animIdRef.current);
      window.removeEventListener("resize", onResize);
      removeMouseHandlers();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      geo.dispose();
      mat.dispose();
      renderer.dispose();
    };
  }, [setupMouseHandlers]);

  return (
    <div
      ref={mountRef}
      className="w-full h-full bg-transparent cursor-grab active:cursor-grabbing"
      title="Drag to rotate · Scroll to zoom"
    />
  );
}

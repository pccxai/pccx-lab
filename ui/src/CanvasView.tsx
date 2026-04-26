import { useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { useVisibilityGate } from "./hooks/useVisibilityGate";

const ROWS = 32;
const COLS = 32;
const COUNT = ROWS * COLS;

const _tmpHsl = new THREE.Color();

/** Maps [0,1] utilisation to RGB bytes (blue=idle, green=active, red=hot). */
function utilToRgb(util: number): [number, number, number] {
  const hue = (1.0 - util) * 220;
  const c = _tmpHsl.setHSL(hue / 360, 0.9, 0.55);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

interface CanvasViewProps { animated?: boolean; isPlaying?: boolean }

export function CanvasView({ animated = true, isPlaying }: CanvasViewProps = {}) {
  const animationEnabled = isPlaying ?? animated;
  const animRef = useRef<boolean>(animationEnabled);
  animRef.current = animationEnabled;
  const mountRef  = useRef<HTMLDivElement>(null);
  const animIdRef = useRef<number>(0);
  const visible = useVisibilityGate(mountRef);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

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

    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
    camera.position.set(0, 0, 28);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // DataTexture for instance colours — avoids per-frame
    // InstancedBufferAttribute upload via setColorAt().
    const texData = new Uint8Array(COLS * ROWS * 4);
    const colorTex = new THREE.DataTexture(
      texData, COLS, ROWS,
      THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    colorTex.minFilter = THREE.NearestFilter;
    colorTex.magFilter = THREE.NearestFilter;
    colorTex.generateMipmaps = false;
    colorTex.needsUpdate = true;

    const geo  = new THREE.BoxGeometry(0.78, 0.78, 0.78);
    const mat  = new THREE.MeshStandardMaterial({
      roughness: 0.25,
      metalness: 0.85,
    });

    // Inject DataTexture sampling into the standard PBR shader so we
    // keep lighting, roughness, metalness without reimplementing them.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uInstColors = { value: colorTex };

      // Vertex: compute UV from gl_InstanceID, pass to fragment.
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>
varying vec2 vInstUV;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vInstUV = (vec2(mod(float(gl_InstanceID), ${COLS}.0),
                floor(float(gl_InstanceID) / ${COLS}.0)) + 0.5) / ${COLS}.0;`,
      );

      // Fragment: sample the texture and apply as diffuse colour.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uInstColors;
varying vec2 vInstUV;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
diffuseColor.rgb = texture2D(uInstColors, vInstUV).rgb;`,
      );
    };

    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dummy = new THREE.Object3D();
    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) {
        const idx = x * ROWS + y;
        dummy.position.set(x - COLS / 2 + 0.5, y - ROWS / 2 + 0.5, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);

        // Write initial "cold" colour into the texture buffer.
        const [r, g, b] = utilToRgb(0.15);
        const off = idx * 4;
        texData[off]     = r;
        texData[off + 1] = g;
        texData[off + 2] = b;
        texData[off + 3] = 255;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    colorTex.needsUpdate = true;

    mouse.current.rotX = 0.3;
    mouse.current.rotY = 0.4;
    mesh.rotation.x = mouse.current.rotX;
    mesh.rotation.y = mouse.current.rotY;
    scene.add(mesh);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
    dirLight.position.set(12, 12, 15);
    scene.add(dirLight);
    scene.add(new THREE.AmbientLight(0x404060, 1.8));
    const rimLight = new THREE.DirectionalLight(0x6060ff, 0.8);
    rimLight.position.set(-10, -8, -5);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(COLS, COLS, 0x1a1a2e, 0x1a1a2e);
    grid.position.y = -(ROWS / 2) - 1;
    scene.add(grid);

    // Cache base colours per instance for the animation pulse.
    const baked = new Uint8Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const [r, g, b] = utilToRgb(0.15);
      baked[i * 3]     = r;
      baked[i * 3 + 1] = g;
      baked[i * 3 + 2] = b;
    }

    // Load live utilisation data.
    invoke<{ core_utils: { core_id: number; util_pct: number }[] }>(
      "get_core_utilisation"
    )
      .then(({ core_utils }) => {
        const utilMap = new Map(core_utils.map((c) => [c.core_id, c.util_pct / 100]));
        for (let x = 0; x < COLS; x++) {
          for (let y = 0; y < ROWS; y++) {
            const idx = x * ROWS + y;
            const coreId = y * COLS + x;
            const util = utilMap.get(coreId % core_utils.length) ?? 0.15;
            const [r, g, b] = utilToRgb(util);
            const off = idx * 4;
            texData[off]     = r;
            texData[off + 1] = g;
            texData[off + 2] = b;
            // Update baked cache for pulse animation.
            baked[idx * 3]     = r;
            baked[idx * 3 + 1] = g;
            baked[idx * 3 + 2] = b;
          }
        }
        colorTex.needsUpdate = true;
      })
      .catch(() => { /* keep "cold" colours if no trace is loaded */ });

    // Sparse column-level dirty check — same threshold as before.
    const lastWave = new Float32Array(COLS);
    for (let i = 0; i < COLS; i++) lastWave[i] = NaN;
    const DIRTY_EPS = 1 / 256;

    let phase = 0;
    const animate = () => {
      animIdRef.current = requestAnimationFrame(animate);
      if (!visibleRef.current) return;

      phase += 0.018;

      if (!mouse.current.dragging) {
        mouse.current.rotY += 0.0008;
        mesh.rotation.y = mouse.current.rotY;
      }

      if (animRef.current) {
        let anyDirty = false;
        for (let x = 0; x < COLS; x++) {
          const wave = 0.5 + 0.5 * Math.sin(phase * 2 - x * 0.4);
          if (!Number.isNaN(lastWave[x]) && Math.abs(wave - lastWave[x]) < DIRTY_EPS) continue;
          lastWave[x] = wave;
          const scale = 0.85 + 0.15 * wave;
          for (let y = 0; y < ROWS; y++) {
            const idx = x * ROWS + y;
            const bOff = idx * 3;
            const tOff = idx * 4;
            texData[tOff]     = Math.min(255, (baked[bOff]     * scale) | 0);
            texData[tOff + 1] = Math.min(255, (baked[bOff + 1] * scale) | 0);
            texData[tOff + 2] = Math.min(255, (baked[bOff + 2] * scale) | 0);
          }
          anyDirty = true;
        }
        if (anyDirty) {
          colorTex.needsUpdate = true;
        }
      }

      renderer.render(scene, camera);
    };
    animate();

    const removeMouseHandlers = setupMouseHandlers(renderer.domElement, mesh, camera);

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
      colorTex.dispose();
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

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import {
  Pen,
  Eraser,
  Trash2,
  Hand,
  Maximize,
  Circle,
  Moon,
  Sun,
} from "lucide-react";

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const BG_LIGHT = "#ffffff";
const BG_DARK = "#000000";

export default function App() {
  const canvasRef = useRef(null);
  const [color, setColor] = useState("#000000");
  const [lineWidth, setLineWidth] = useState(3);
  const [tool, setTool] = useState("pen"); // 'pen' | 'eraser' | 'hand'
  const [isDark, setIsDark] = useState(false); // local view: whiteboard / blackboard

  // Brush cursor overlay
  const cursorRef = useRef(null);
  const cursorPos = useRef({ x: 0, y: 0, show: false });

  // Latest UI values for code running inside long-lived closures (Yjs observer, resize)
  const live = useRef({});
  live.current = { tool, lineWidth, isDark };

  // Yjs refs
  const ydocRef = useRef(null);
  const providerRef = useRef(null);
  const yStrokesRef = useRef(null);
  const activeYPointsRef = useRef(null);

  // Drawing state
  const isDrawing = useRef(false);
  const currentStroke = useRef([]);

  // Camera: screen = world * scale + (x, y). Strokes are stored in WORLD
  // coordinates, so every device sees the same drawing regardless of screen size.
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 });

  // Gesture state
  const pointers = useRef(new Map()); // active pointers by id (screen coords)
  const gesture = useRef(null); // two-finger pan/zoom
  const panStart = useRef(null); // one-pointer pan (hand tool / space / middle mouse)
  const gestureUsed = useRef(false); // true after a pinch, until all fingers lift
  const spaceDown = useRef(false);

  useEffect(() => {
    ydocRef.current = new Y.Doc();
    const roomName = window.location.hash.substring(1) || "room-0";
    window.location.hash = roomName;

    providerRef.current = new WebsocketProvider(
      'wss://p2p-whiteboard-backend.onrender.com',
      // "ws://localhost:1234",
      roomName,
      ydocRef.current,
    );

    providerRef.current.on("status", (event) => {
      console.log("WebSocket status:", event.status);
    });
    providerRef.current.on("sync", (isSynced) => {
      console.log("WebSocket Synced:", isSynced);
    });

    yStrokesRef.current = ydocRef.current.getArray("strokes");
    yStrokesRef.current.observeDeep(() => redrawCanvas());

    const canvas = canvasRef.current;

    const handleResize = () => {
      if (!canvas) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * ratio;
      canvas.height = window.innerHeight * ratio;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      redrawCanvas();
    };

    // Trackpad two-finger scroll = pan, pinch / Ctrl+wheel = zoom.
    // Must be a native, non-passive listener so we can preventDefault.
    const handleWheel = (e) => {
      e.preventDefault();
      const cam = cameraRef.current;
      if (e.ctrlKey || e.metaKey) {
        const scale = clamp(
          cam.scale * Math.exp(-e.deltaY * 0.01),
          MIN_SCALE,
          MAX_SCALE,
        );
        const wx = (e.clientX - cam.x) / cam.scale;
        const wy = (e.clientY - cam.y) / cam.scale;
        cameraRef.current = {
          scale,
          x: e.clientX - wx * scale,
          y: e.clientY - wy * scale,
        };
      } else {
        cameraRef.current = {
          ...cam,
          x: cam.x - e.deltaX,
          y: cam.y - e.deltaY,
        };
      }
      redrawCanvas();
    };

    // Hold Space to pan with mouse
    const onKeyDown = (e) => {
      if (e.code === "Space" && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
        spaceDown.current = true;
        e.preventDefault();
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") spaceDown.current = false;
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    handleResize();

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("wheel", handleWheel);
      if (providerRef.current) providerRef.current.destroy();
      if (ydocRef.current) ydocRef.current.destroy();
    };
  }, []);

  // ---------- Rendering ----------

  // Circle cursor sized to the brush (scales with zoom), styled per tool and board
  const updateCursor = () => {
    const el = cursorRef.current;
    if (!el) return;
    const { tool, lineWidth, isDark } = live.current;
    const p = cursorPos.current;
    if (!p.show || tool === "hand") {
      el.style.display = "none";
      return;
    }
    const d = Math.max(lineWidth * cameraRef.current.scale, 4);
    const s = el.style;
    s.display = "block";
    s.width = `${d}px`;
    s.height = `${d}px`;
    s.transform = `translate(${p.x - d / 2}px, ${p.y - d / 2}px)`;
    if (tool === "eraser") {
      s.background = "#ffffff";
      s.border = isDark ? "none" : "3px solid #000000";
    } else {
      s.background = isDark ? "#ffffff" : "#000000";
      s.border = "none";
    }
  };

  const applyTransform = (ctx) => {
    const ratio = window.devicePixelRatio || 1;
    const { x, y, scale } = cameraRef.current;
    ctx.setTransform(ratio * scale, 0, 0, ratio * scale, x * ratio, y * ratio);
  };

  const redrawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas || !yStrokesRef.current) return;
    const ctx = canvas.getContext("2d");

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyTransform(ctx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    yStrokesRef.current.toArray().forEach((yStroke) => {
      const yPoints = yStroke.get("points");
      if (!yPoints) return;
      const points = yPoints.toArray();
      if (points.length === 0) return;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      ctx.strokeStyle = yStroke.get("erase")
        ? live.current.isDark
          ? BG_DARK
          : BG_LIGHT
        : yStroke.get("color");
      ctx.lineWidth = yStroke.get("width");
      for (let i = 1; i < points.length; i++)
        ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    });
    updateCursor(); // keeps cursor size in sync while zooming
  };

  // Zoom/pan so everything that has been drawn is visible on THIS screen
  const fitToDrawing = () => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    yStrokesRef.current.forEach((yStroke) => {
      const yPoints = yStroke.get("points");
      if (!yPoints) return;
      yPoints.forEach((p) => {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      });
    });

    if (minX === Infinity) {
      cameraRef.current = { x: 0, y: 0, scale: 1 };
    } else {
      const pad = 80;
      const w = Math.max(maxX - minX, 1);
      const h = Math.max(maxY - minY, 1);
      const scale = clamp(
        Math.min(
          (window.innerWidth - pad * 2) / w,
          (window.innerHeight - pad * 2) / h,
        ),
        MIN_SCALE,
        2,
      );
      cameraRef.current = {
        scale,
        x: window.innerWidth / 2 - ((minX + maxX) / 2) * scale,
        y: window.innerHeight / 2 - ((minY + maxY) / 2) * scale,
      };
    }
    redrawCanvas();
  };

  // ---------- Drawing ----------

  const toWorld = (sx, sy) => {
    const { x, y, scale } = cameraRef.current;
    return { x: (sx - x) / scale, y: (sy - y) / scale };
  };

  const strokeColor = tool === "eraser" ? (isDark ? BG_DARK : BG_LIGHT) : color;

  const startStroke = (clientX, clientY) => {
    isDrawing.current = true;
    const p = toWorld(clientX, clientY);

    const yStroke = new Y.Map();
    yStroke.set("color", color);
    yStroke.set("erase", tool === "eraser");
    yStroke.set("width", lineWidth);

    const yPoints = new Y.Array();
    yPoints.push([p]);
    yStroke.set("points", yPoints);

    activeYPointsRef.current = yPoints;
    yStrokesRef.current.push([yStroke]);
    currentStroke.current = [p];
  };

  const extendStroke = (clientX, clientY) => {
    const p = toWorld(clientX, clientY);
    activeYPointsRef.current.push([p]);

    // Local optimistic segment
    const prev = currentStroke.current[currentStroke.current.length - 1];
    currentStroke.current.push(p);
    const ctx = canvasRef.current.getContext("2d");
    applyTransform(ctx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const endStroke = () => {
    isDrawing.current = false;
    activeYPointsRef.current = null;
    currentStroke.current = [];
  };

  // ---------- Pointer handling (mouse, touch, stylus) ----------

  const beginGesture = () => {
    const [a, b] = [...pointers.current.values()];
    gesture.current = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      cam: { ...cameraRef.current },
    };
    panStart.current = null;
    gestureUsed.current = true;
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.button === 1) e.preventDefault(); // middle mouse: no autoscroll

    if (pointers.current.size === 1) gestureUsed.current = false;

    // Second finger down: stop drawing, switch to pan/zoom
    if (pointers.current.size >= 2) {
      endStroke();
      beginGesture();
      return;
    }
    if (gestureUsed.current) return;

    const wantsPan = tool === "hand" || e.button === 1 || spaceDown.current;
    if (wantsPan) {
      const cam = cameraRef.current;
      panStart.current = { px: e.clientX, py: e.clientY, cx: cam.x, cy: cam.y };
      return;
    }

    if (e.pointerType === "mouse" && e.button !== 0) return;
    startStroke(e.clientX, e.clientY);
  };

  const onPointerMove = (e) => {
    cursorPos.current = {
      x: e.clientX,
      y: e.clientY,
      show: e.pointerType !== "touch",
    };
    updateCursor();
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two-finger pan + pinch zoom
    if (gesture.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const g = gesture.current;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = clamp(g.cam.scale * (dist / g.dist), MIN_SCALE, MAX_SCALE);
      // Keep the world point under the original midpoint under the current midpoint
      const wx = (g.mid.x - g.cam.x) / g.cam.scale;
      const wy = (g.mid.y - g.cam.y) / g.cam.scale;
      cameraRef.current = {
        scale,
        x: mid.x - wx * scale,
        y: mid.y - wy * scale,
      };
      redrawCanvas();
      return;
    }

    // One-pointer pan
    if (panStart.current) {
      const s = panStart.current;
      cameraRef.current = {
        ...cameraRef.current,
        x: s.cx + (e.clientX - s.px),
        y: s.cy + (e.clientY - s.py),
      };
      redrawCanvas();
      return;
    }

    if (isDrawing.current) extendStroke(e.clientX, e.clientY);
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) {
      panStart.current = null;
      endStroke();
      gestureUsed.current = false;
    }
  };

  // Re-render strokes and restyle the cursor when board, tool or brush size changes
  useEffect(() => {
    redrawCanvas();
    updateCursor();
  }, [isDark, tool, lineWidth]);

  const toggleBoard = () => {
    const next = !isDark;
    setIsDark(next);
    // Swap default ink so the pen is visible on the new board
    setColor((c) => {
      const l = c.toLowerCase();
      if (next && l === "#000000") return "#ffffff";
      if (!next && l === "#ffffff") return "#000000";
      return c;
    });
  };

  const clearBoard = () => {
    yStrokesRef.current.delete(0, yStrokesRef.current.length);
  };

  return (
    <>
      <div className="toolbar-container">
        <button
          className={`tool-btn ${tool === "pen" ? "active" : ""}`}
          onClick={() => setTool("pen")}
          title="Pen"
        >
          <Pen size={22} strokeWidth={2.5} />
        </button>

        <button
          className={`tool-btn ${tool === "eraser" ? "active" : ""}`}
          onClick={() => setTool("eraser")}
          title="Eraser"
        >
          <Eraser size={22} strokeWidth={2.5} />
        </button>

        <button
          className={`tool-btn ${tool === "hand" ? "active" : ""}`}
          onClick={() => setTool("hand")}
          title="Move board (or use two fingers / hold Space)"
        >
          <Hand size={22} strokeWidth={2.5} />
        </button>

        <div className="divider" />

        <div className="color-picker-wrapper">
          <input
            type="color"
            value={color}
            onChange={(e) => {
              setColor(e.target.value);
              setTool("pen"); // switch back to pen when a colour is picked
            }}
          />
        </div>

        <div className="divider" />

        <div className="slider-container">
          <Circle size={14} strokeWidth={3} />
          <input
            type="range"
            min="1"
            max="80"
            value={lineWidth}
            onChange={(e) => setLineWidth(Number(e.target.value))}
          />
          <Circle size={22} strokeWidth={3} />
        </div>

        <div className="divider" />

        <button
          className="tool-btn"
          onClick={fitToDrawing}
          title="Fit all drawings on screen"
        >
          <Maximize size={22} strokeWidth={2.5} />
        </button>

        <button className="tool-btn" onClick={clearBoard} title="Clear Board">
          <Trash2 size={22} strokeWidth={2.5} />
        </button>

        <button
          className="tool-btn"
          onClick={toggleBoard}
          title={isDark ? "Switch to whiteboard" : "Switch to blackboard"}
        >
          {isDark ? (
            <Sun size={22} strokeWidth={2.5} />
          ) : (
            <Moon size={22} strokeWidth={2.5} />
          )}
        </button>
      </div>

      <canvas
        ref={canvasRef}
        className={tool === "hand" ? "is-hand" : "is-draw"}
        style={{ background: isDark ? BG_DARK : BG_LIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          cursorPos.current.show = false;
          updateCursor();
        }}
      />

      <div ref={cursorRef} className="brush-cursor" />
    </>
  );
}

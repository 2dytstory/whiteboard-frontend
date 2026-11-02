import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { Pen, Eraser, Trash2, Eye, EyeOff, Circle } from 'lucide-react';

export default function App() {
  const canvasRef = useRef(null);
  const [color, setColor] = useState('#000000');
  const [lineWidth, setLineWidth] = useState(3);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [isEraser, setIsEraser] = useState(false);
  const [previousColor, setPreviousColor] = useState('#000000');
  
  // Yjs State Refs
  const ydocRef = useRef(null);
  const providerRef = useRef(null);
  const yStrokesRef = useRef(null);
  const activeYPointsRef = useRef(null);
  
  // Local Drawing State
  const isDrawing = useRef(false);
  const currentStroke = useRef([]);

  useEffect(() => {
    ydocRef.current = new Y.Doc();
    const roomName = window.location.hash.substring(1) || 'room-0';
    window.location.hash = roomName;
    
    providerRef.current = new WebrtcProvider(roomName, ydocRef.current, {
      signaling: ['wss://p2p-whiteboard-backend.onrender.com/'],
      filterBcConns: false,
      peerOpts: {
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      }
    });

    // Track when a connection to the signaling server is established
    providerRef.current.on('synced', synced => {
      console.log('WebRTC Synced:', synced);
    });

    // Track when other users actually join your room
    providerRef.current.on('peers', peers => {
      console.log('Connected peers count:', peers.webrtcPeers.length);
    });

    yStrokesRef.current = ydocRef.current.getArray('strokes');
    yStrokesRef.current.observeDeep(() => {
      redrawCanvas();
    });

    const handleResize = () => {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * ratio;
      canvas.height = window.innerHeight * ratio;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.scale(ratio, ratio);
      redrawCanvas();
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      providerRef.current.destroy();
      ydocRef.current.destroy();
    };
  }, []);

  const redrawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const allStrokes = yStrokesRef.current.toArray();
    
    allStrokes.forEach(yStroke => {
      // Extract data using Yjs getter methods
      const strokeColor = yStroke.get('color');
      const strokeWidth = yStroke.get('width');
      const yPoints = yStroke.get('points');

      if (!yPoints) return;
      const points = yPoints.toArray(); // Convert Y.Array back to standard JS array for rendering

      if (points.length === 0) return;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    });
  };

  // Pointer Events API (Handles Mouse, Touch, and Stylus uniformly)
  const startDrawing = (e) => {
    if (isReadOnly) return;
    isDrawing.current = true;
    const { clientX, clientY } = e;

    // 1. Create a CRDT Map for the stroke properties
    const yStroke = new Y.Map();
    yStroke.set('color', color);
    yStroke.set('width', lineWidth);

    // 2. Create a CRDT Array for the points and add the starting point
    const yPoints = new Y.Array();
    yPoints.push([{ x: clientX, y: clientY }]);
    yStroke.set('points', yPoints);

    // 3. Save a reference so the `draw` function can push to this exact array
    activeYPointsRef.current = yPoints;

    // 4. Push to the main shared document (peers see the start of the line immediately)
    yStrokesRef.current.push([yStroke]);

    currentStroke.current = [{ x: clientX, y: clientY }];
  };

  const draw = (e) => {
    if (!isDrawing.current || isReadOnly) return;
    const { clientX, clientY } = e;

    // Push the new point directly to Yjs. 
    // observeDeep catches this and instantly broadcasts it to all peers!
    activeYPointsRef.current.push([{ x: clientX, y: clientY }]);

    // Local optimistic update for zero perceived latency
    currentStroke.current.push({ x: clientX, y: clientY });
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    const points = currentStroke.current;
    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[points.length - 2].x, points[points.length - 2].y);
      ctx.lineTo(clientX, clientY);
      ctx.stroke();
    }
  };

  const stopDrawing = () => {
    if (!isDrawing.current || isReadOnly) return;
    isDrawing.current = false;
    activeYPointsRef.current = null;
    currentStroke.current = [];
  };

  const clearBoard = () => {
    if (isReadOnly) return;
    // Clearing the Yjs array automatically triggers deletion for all peers
    yStrokesRef.current.delete(0, yStrokesRef.current.length);
  };

  return (
    <>
      <div className="toolbar-container">
        {/* Pen Tool */}
        <button 
          className={`tool-btn ${!isEraser && !isReadOnly ? 'active' : ''}`}
          onClick={() => {
            setIsEraser(false);
            setColor(previousColor);
          }}
          disabled={isReadOnly}
          title="Pen"
        >
          <Pen size={22} strokeWidth={2.5} />
        </button>

        {/* Eraser Tool */}
        <button 
          className={`tool-btn ${isEraser && !isReadOnly ? 'active' : ''}`}
          onClick={() => {
            if (!isEraser) setPreviousColor(color);
            setIsEraser(true);
            setColor('#ffffff');
          }}
          disabled={isReadOnly}
          title="Eraser"
        >
          <Eraser size={22} strokeWidth={2.5} />
        </button>

        <div className="divider" />

        {/* Color Picker Component */}
        <div className="color-picker-wrapper" style={{ opacity: isReadOnly ? 0.4 : 1 }}>
          <input 
            type="color" 
            value={isEraser ? previousColor : color} 
            onChange={(e) => {
              setColor(e.target.value);
              setPreviousColor(e.target.value);
              setIsEraser(false); // Auto-switch to pen if they change color
            }} 
            disabled={isReadOnly}
          />
        </div>

        <div className="divider" />

        {/* Brush Size Slider */}
        <div className="slider-container" style={{ opacity: isReadOnly ? 0.4 : 1 }}>
          <Circle size={14} strokeWidth={3} />
          <input 
            type="range" 
            min="1" max="30" 
            value={lineWidth} 
            onChange={(e) => setLineWidth(Number(e.target.value))}
            disabled={isReadOnly}
          />
          <Circle size={22} strokeWidth={3} />
        </div>

        <div className="divider" />

        {/* Clear Canvas */}
        <button 
          className="tool-btn" 
          onClick={clearBoard} 
          disabled={isReadOnly}
          title="Clear Board"
        >
          <Trash2 size={22} strokeWidth={2.5} />
        </button>

        <div className="divider" />

        {/* Spectator Mode Toggle */}
        <button 
          className={`tool-btn ${isReadOnly ? 'active' : ''}`} 
          onClick={() => setIsReadOnly(!isReadOnly)}
          title={isReadOnly ? "Switch to Drawing Mode" : "Switch to Spectator Mode"}
        >
          {isReadOnly ? <Eye size={22} strokeWidth={2.5} /> : <EyeOff size={22} strokeWidth={2.5} />}
        </button>
      </div>

      <canvas
        ref={canvasRef}
        onPointerDown={startDrawing}
        onPointerMove={draw}
        onPointerUp={stopDrawing}
        onPointerOut={stopDrawing}
      />
    </>
  );
}
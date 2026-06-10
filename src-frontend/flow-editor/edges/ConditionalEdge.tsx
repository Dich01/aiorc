import React from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useEdges,
  useNodes,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
} from '@xyflow/react';
import type { EdgeData } from '../types';

interface Props extends EdgeProps {
  data?: EdgeData;
}

const RADIUS = 10;
const PAD = 22;
const ENTRY = 18;
const NODE_PADDING = 8;
const HORIZONTAL_TOLERANCE = 6;
const Y_TOLERANCE = 14;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type Point = [number, number];

function rectIntersectsHorizontal(rect: Rect, y: number, x1: number, x2: number): boolean {
  if (y <= rect.top || y >= rect.bottom) return false;
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  return rect.right > lo && rect.left < hi;
}

function rectIntersectsVertical(rect: Rect, x: number, y1: number, y2: number): boolean {
  if (x <= rect.left || x >= rect.right) return false;
  const lo = Math.min(y1, y2);
  const hi = Math.max(y1, y2);
  return rect.bottom > lo && rect.top < hi;
}

function buildOrthogonalPath(rawPoints: Point[]): string {
  // Dedupe consecutive duplicates
  const pts = rawPoints.filter((p, i) =>
    i === 0 || p[0] !== rawPoints[i - 1][0] || p[1] !== rawPoints[i - 1][1]
  );

  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;

  let path = `M${pts[0][0]},${pts[0][1]}`;

  for (let i = 1; i < pts.length; i++) {
    if (i === pts.length - 1) {
      path += ` L${pts[i][0]},${pts[i][1]}`;
    } else {
      const [px, py] = pts[i - 1];
      const [cx, cy] = pts[i];
      const [nx, ny] = pts[i + 1];

      const inDx = cx - px;
      const inDy = cy - py;
      const outDx = nx - cx;
      const outDy = ny - cy;

      const inLen = Math.hypot(inDx, inDy);
      const outLen = Math.hypot(outDx, outDy);
      const cross = inDx * outDy - inDy * outDx;

      if (cross === 0 || inLen === 0 || outLen === 0) {
        path += ` L${cx},${cy}`;
        continue;
      }

      const r = Math.min(RADIUS, inLen / 2, outLen / 2);
      const beforeX = cx - (inDx / inLen) * r;
      const beforeY = cy - (inDy / inLen) * r;
      const afterX = cx + (outDx / outLen) * r;
      const afterY = cy + (outDy / outLen) * r;

      path += ` L${beforeX},${beforeY}`;
      path += ` Q${cx},${cy} ${afterX},${afterY}`;
    }
  }

  return path;
}

function buildSmartPath(
  sx: number, sy: number,
  tx: number, ty: number,
  source: string,
  target: string,
  nodes: Node[],
  preferredMidY?: number
): { path: string; labelX: number; labelY: number } {
  const obstacles: Rect[] = nodes
    .filter(n => n.id !== source && n.id !== target)
    .map(n => {
      const w = n.measured?.width ?? n.width ?? 220;
      const h = n.measured?.height ?? n.height ?? 90;
      return {
        left: n.position.x - NODE_PADDING,
        right: n.position.x + w + NODE_PADDING,
        top: n.position.y - NODE_PADDING,
        bottom: n.position.y + h + NODE_PADDING,
      };
    });

  const minX = Math.min(sx, tx);
  const maxX = Math.max(sx, tx);
  const minY = Math.min(sy, ty);
  const maxY = Math.max(sy, ty);

  // Blockers in the direct rectangular corridor between source and target
  const blockers = obstacles.filter(o =>
    o.right > minX - HORIZONTAL_TOLERANCE && o.left < maxX + HORIZONTAL_TOLERANCE &&
    o.bottom > minY && o.top < maxY
  );

  if (blockers.length === 0) {
    const naturalMidY = (sy + ty) / 2;
    const lo = Math.min(sy, ty) + 8;
    const hi = Math.max(sy, ty) - 8;
    const midY = preferredMidY !== undefined
      ? Math.max(lo, Math.min(hi, preferredMidY))
      : naturalMidY;
    const points: Point[] = [[sx, sy], [sx, midY], [tx, midY], [tx, ty]];
    return {
      path: buildOrthogonalPath(points),
      labelX: (sx + tx) / 2,
      labelY: midY,
    };
  }

  const blockTop = Math.min(...blockers.map(b => b.top));
  const blockBottom = Math.max(...blockers.map(b => b.bottom));
  const blockLeft = Math.min(...blockers.map(b => b.left));
  const blockRight = Math.max(...blockers.map(b => b.right));

  // 1) Try a clean horizontal channel ABOVE all blockers
  const yAbove = Math.max(sy + ENTRY * 0.5, blockTop - PAD);
  if (yAbove < blockTop && yAbove > Math.min(sy, ty) && yAbove < Math.max(sy, ty)) {
    const horizontalClear = !obstacles.some(o => rectIntersectsHorizontal(o, yAbove, sx, tx));
    if (horizontalClear) {
      const points: Point[] = [[sx, sy], [sx, yAbove], [tx, yAbove], [tx, ty]];
      return {
        path: buildOrthogonalPath(points),
        labelX: (sx + tx) / 2,
        labelY: yAbove,
      };
    }
  }

  // 2) Try a clean horizontal channel BELOW all blockers
  const yBelow = Math.min(ty - ENTRY * 0.5, blockBottom + PAD);
  if (yBelow > blockBottom && yBelow > Math.min(sy, ty) && yBelow < Math.max(sy, ty)) {
    const horizontalClear = !obstacles.some(o => rectIntersectsHorizontal(o, yBelow, sx, tx));
    if (horizontalClear) {
      const points: Point[] = [[sx, sy], [sx, yBelow], [tx, yBelow], [tx, ty]];
      return {
        path: buildOrthogonalPath(points),
        labelX: (sx + tx) / 2,
        labelY: yBelow,
      };
    }
  }

  // 3) Route around the side via a 5-bend path
  const sideRight = blockRight + PAD;
  const sideLeft = blockLeft - PAD;

  // Score each side by total detour
  function detour(sideX: number): number {
    return Math.abs(sx - sideX) + Math.abs(sideX - tx);
  }
  const goRight = detour(sideRight) <= detour(sideLeft);
  let sideX = goRight ? sideRight : sideLeft;

  // Make sure the side corridor itself isn't blocked by other nodes
  const sideObstacles = obstacles.filter(o =>
    rectIntersectsVertical(o, sideX, blockTop - PAD, blockBottom + PAD)
  );
  if (sideObstacles.length > 0) {
    // Push further out to clear them
    if (goRight) {
      const maxR = Math.max(...sideObstacles.map(o => o.right));
      sideX = maxR + PAD;
    } else {
      const minL = Math.min(...sideObstacles.map(o => o.left));
      sideX = minL - PAD;
    }
  }

  const entryY = Math.max(Math.min(sy, ty) + 4, Math.min(sy + ENTRY, blockTop - PAD));
  const exitY = Math.min(Math.max(sy, ty) - 4, Math.max(ty - ENTRY, blockBottom + PAD));

  const points: Point[] = [
    [sx, sy],
    [sx, entryY],
    [sideX, entryY],
    [sideX, exitY],
    [tx, exitY],
    [tx, ty],
  ];

  return {
    path: buildOrthogonalPath(points),
    labelX: sideX,
    labelY: (entryY + exitY) / 2,
  };
}

function nodeCenterX(n: Node | undefined): number | null {
  if (!n) return null;
  const w = n.measured?.width ?? n.width ?? 220;
  return n.position.x + w / 2;
}

function nodeBottom(n: Node | undefined): number | null {
  if (!n) return null;
  const h = n.measured?.height ?? n.height ?? 90;
  return n.position.y + h;
}

function computePreferredMidY(
  id: string,
  sx: number, sy: number,
  tx: number, ty: number,
  edges: Edge[],
  nodes: Node[]
): number {
  const naturalMidY = (sy + ty) / 2;
  const myXLo = Math.min(sx, tx);
  const myXHi = Math.max(sx, tx);

  // Deterministic ordering: sort edges by id so all edges agree on who shifts.
  const sorted = [...edges].sort((a, b) => a.id.localeCompare(b.id));
  const myIdx = sorted.findIndex(e => e.id === id);
  if (myIdx <= 0) return naturalMidY;

  const earlierMidYs: number[] = [];
  for (let i = 0; i < myIdx; i++) {
    const other = sorted[i];
    const oS = nodes.find(n => n.id === other.source);
    const oT = nodes.find(n => n.id === other.target);
    const oSx = nodeCenterX(oS);
    const oSy = nodeBottom(oS);
    const oTx = nodeCenterX(oT);
    const oTy = oT?.position.y ?? null;
    if (oSx === null || oSy === null || oTx === null || oTy === null) continue;

    const oXLo = Math.min(oSx, oTx);
    const oXHi = Math.max(oSx, oTx);
    // If X corridors don't overlap, no horizontal-segment conflict possible
    if (oXHi < myXLo - 4 || oXLo > myXHi + 4) continue;

    earlierMidYs.push((oSy + oTy) / 2);
  }

  if (earlierMidYs.length === 0) return naturalMidY;

  // Try natural midY first, then offset progressively
  let candidate = naturalMidY;
  let attempts = 0;
  while (earlierMidYs.some(y => Math.abs(y - candidate) < Y_TOLERANCE) && attempts < 10) {
    attempts += 1;
    const step = Math.ceil(attempts / 2) * Y_TOLERANCE;
    candidate = naturalMidY + (attempts % 2 === 1 ? step : -step);
  }
  return candidate;
}

export default function ConditionalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  source,
  target,
  data,
  selected,
  markerEnd,
  style,
}: Props) {
  const nodes = useNodes();
  const edges = useEdges();
  const preferredMidY = computePreferredMidY(id, sourceX, sourceY, targetX, targetY, edges, nodes);
  const { path, labelX, labelY } = buildSmartPath(sourceX, sourceY, targetX, targetY, source, target, nodes, preferredMidY);

  const { setEdges } = useReactFlow();

  function onDeleteEdge(e: React.MouseEvent) {
    e.stopPropagation();
    setEdges((edges) => edges.filter((edge) => edge.id !== id));
  }

  const condition = data?.condition;
  const shortLabel = condition
    ? condition.length > 32
      ? condition.slice(0, 30) + '…'
      : condition
    : null;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? '#6366f1' : '#94a3b8',
          strokeWidth: selected ? 2.5 : 1.8,
          fill: 'none',
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className={`edge-label-container${selected ? ' selected' : ''}`}
        >
          {shortLabel ? (
            <div
              className="edge-condition-label"
              onClick={(e) => {
                e.stopPropagation();
                data?.onEditCondition?.(id);
              }}
              title={condition + '\n\n(click to edit)'}
            >
              {shortLabel}
            </div>
          ) : selected ? (
            <div
              className="edge-condition-label edge-condition-empty"
              onClick={(e) => {
                e.stopPropagation();
                data?.onEditCondition?.(id);
              }}
              title="Add condition"
            >
              + condition
            </div>
          ) : null}
          {selected && (
            <button className="edge-delete-btn" onClick={onDeleteEdge} title="Delete edge">
              ×
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

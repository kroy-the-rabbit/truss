import React, { useMemo } from 'react';

interface MetricsLineChartProps {
  data: { t: number; v: number }[];
  width?: number;
  height?: number;
  color: string;
  formatY: (v: number) => string;
  label: string;
  loading?: boolean;
}

const PAD = { top: 10, right: 12, bottom: 28, left: 52 };

export function MetricsLineChart({
  data,
  width = 300,
  height = 120,
  color,
  formatY,
  label,
  loading,
}: MetricsLineChartProps) {
  const inner = {
    w: width - PAD.left - PAD.right,
    h: height - PAD.top - PAD.bottom,
  };

  const { path, areaPath, yLabels, xLabels } = useMemo(() => {
    if (!data || data.length < 2) return { path: '', areaPath: '', yLabels: [], xLabels: [] };

    const maxV = Math.max(...data.map((d) => d.v)) * 1.1 || 1;
    const minT = data[0].t;
    const maxT = data[data.length - 1].t;
    const rangeT = maxT - minT || 1;

    const toX = (t: number) => ((t - minT) / rangeT) * inner.w;
    const toY = (v: number) => inner.h - (v / maxV) * inner.h;

    const pts = data.map((d) => ({ x: toX(d.t), y: toY(d.v) }));

    const lineSegments = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area =
      lineSegments +
      ` L${pts[pts.length - 1].x.toFixed(1)},${inner.h} L${pts[0].x.toFixed(1)},${inner.h} Z`;

    // Y-axis: 4 gridlines
    const yL = [0, 1, 2, 3].map((i) => {
      const v = (maxV / 3) * i;
      const y = toY(v);
      return { y, label: formatY(v) };
    });

    // X-axis: 4 labels
    const now = maxT;
    const xL = [0, 1, 2, 3].map((i) => {
      const t = minT + (rangeT / 3) * i;
      const diffSec = now - t;
      let lbl: string;
      if (diffSec < 60) lbl = 'now';
      else if (diffSec < 3600) lbl = `-${Math.round(diffSec / 60)}m`;
      else lbl = `-${(diffSec / 3600).toFixed(1)}h`;
      return { x: toX(t), label: lbl };
    });

    return { path: lineSegments, areaPath: area, yLabels: yL, xLabels: xL };
  }, [data, inner.w, inner.h, formatY]);

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {/* Gridlines + Y labels */}
        {yLabels.map((yl, i) => (
          <g key={i}>
            <line
              x1={0}
              y1={yl.y}
              x2={inner.w}
              y2={yl.y}
              stroke="var(--border)"
              strokeWidth={0.5}
              strokeDasharray="3,3"
            />
            <text
              x={-4}
              y={yl.y}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={9}
              fill="var(--text-dim)"
            >
              {yl.label}
            </text>
          </g>
        ))}

        {/* X labels */}
        {xLabels.map((xl, i) => (
          <text
            key={i}
            x={xl.x}
            y={inner.h + 14}
            textAnchor="middle"
            fontSize={9}
            fill="var(--text-dim)"
          >
            {xl.label}
          </text>
        ))}

        {loading || data.length < 2 ? (
          <>
            <rect
              width={inner.w}
              height={inner.h}
              fill="var(--bg-hover)"
              rx={4}
              opacity={0.4}
            />
            <text
              x={inner.w / 2}
              y={inner.h / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--text-dim)"
            >
              {loading ? 'Loading…' : 'No data'}
            </text>
          </>
        ) : (
          <>
            {areaPath && (
              <path d={areaPath} fill={color} opacity={0.08} />
            )}
            <path
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}

        {/* Chart label */}
        <text
          x={inner.w / 2}
          y={-2}
          textAnchor="middle"
          fontSize={10}
          fill="var(--text-secondary)"
          fontWeight={500}
        >
          {label}
        </text>
      </g>
    </svg>
  );
}

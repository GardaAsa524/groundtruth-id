/**
 * components/HeatOverlay.jsx
 * ---------------------------------------------------------------------------
 * Penyambung lapisan peta panas ke React. Wajib di dalam <MapContainer>.
 */

import { useEffect, useRef, useMemo } from 'react';
import { useMap } from 'react-leaflet';
import L from '../core/geo/leafletGlobal.js';
import { createHeatLayer, heatPoints } from '../core/accuracy/heat.js';

export function HeatOverlay({ samples, mode }) {
  const map = useMap();
  const layerRef = useRef(null);

  const points = useMemo(
    () => (mode && mode !== 'off' ? heatPoints(samples, mode) : []),
    [samples, mode]
  );

  useEffect(() => {
    if (!map) return undefined;
    const HeatLayer = createHeatLayer(L);
    const layer = new HeatLayer([]);
    layer.addTo(map);
    layerRef.current = layer;
    return () => { map.removeLayer(layer); layerRef.current = null; };
  }, [map]);

  // Titik diperbarui tanpa membangun ulang lapisan; membuat ulang kanvas pada
  // tiap perubahan mode akan berkedip.
  useEffect(() => {
    layerRef.current?.setPoints(points);
  }, [points]);

  return null;
}

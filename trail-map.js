/* Loaded on the trail page. The map and walkway data are only used by the sender. */
(() => {
  'use strict';

  const leaflet = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet';
  const bounds = [[39.993, -105.287], [40.016, -105.238]];
  const walkStyle = { color: '#edce88', weight: 3, opacity: 0.85, interactive: false };

  function loadAsset(element) {
    return new Promise((resolve, reject) => {
      element.crossOrigin = 'anonymous';
      element.onload = resolve;
      element.onerror = reject;
      document.head.append(element);
    });
  }

  async function initMap(container, onSelect, onMiss) {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = leaflet + '.css';
    style.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
    const script = document.createElement('script');
    script.src = leaflet + '.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    const [paths] = await Promise.all([
      fetch('paths.geojson').then(response => {
        if (!response.ok) throw new Error('Could not load walkways');
        return response.json();
      }),
      loadAsset(style),
      loadAsset(script)
    ]);
    const L = window.L;
    const map = L.map(container, {
      minZoom: 14, maxZoom: 19, maxBounds: bounds, maxBoundsViscosity: 1, scrollWheelZoom: false
    }).setView([40.0088, -105.2721], 17);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar'
    }).addTo(map);
    map.attributionControl.addAttribution('Walkways &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');

    const walkways = paths.features.filter(feature => feature.geometry.type === 'LineString'
      && !feature.properties.tags?.includes('stairs') && !feature.properties.tags?.includes('goat'));
    L.geoJSON(walkways, { style: walkStyle }).addTo(map);
    const zoom = 18;
    const segments = walkways.flatMap(feature => {
      const points = feature.geometry.coordinates.map(([lng, lat]) => map.project([lat, lng], zoom));
      const name = feature.properties.named ? feature.properties.name : 'Campus walkway';
      return points.slice(1).map((point, i) => ({ a: points[i], b: point, name }));
    });
    const centerDot = L.circleMarker(map.getCenter(), {
      radius: 5, color: '#fff', weight: 2, fill: false, interactive: false, className: 'trail-crosshair'
    }).addTo(map);
    map.on('move', () => centerDot.setLatLng(map.getCenter()));

    const campus = L.latLngBounds(bounds);
    let pin;
    function pick(latlng) {
      const target = map.project(latlng, zoom);
      let closest;
      let distance = Infinity;
      for (const segment of segments) {
        const point = L.LineUtil.closestPointOnSegment(target, segment.a, segment.b);
        const candidate = target.distanceTo(point);
        if (candidate < distance) {
          closest = { point, name: segment.name };
          distance = candidate;
        }
      }
      const spot = closest && map.unproject(closest.point, zoom);
      if (!spot || !campus.contains(spot) || map.distance(latlng, spot) > 28) {
        onMiss();
        return;
      }
      if (!onSelect({ lat: spot.lat, lng: spot.lng, name: closest.name })) return;
      if (pin) pin.setLatLng(spot);
      else pin = L.circleMarker(spot, {
        radius: 8, color: '#fff', weight: 2, fillColor: '#b68b30', fillOpacity: 1, interactive: false
      }).addTo(map);
    }

    map.on('click', event => pick(event.latlng));
    return {
      pickCenter: () => pick(map.getCenter()),
      resize: () => map.invalidateSize(),
      reset: () => {
        if (pin) pin.remove();
        pin = null;
        map.invalidateSize();
      }
    };
  }

  window.TrailMap = { initMap };
})();

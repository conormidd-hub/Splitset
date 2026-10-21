import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cafeBox, cafeQuery, nearestCafe, parseOverpass, parsePhoton, samePlace } from './places.ts';

test('photon features become places with a name and a locality trail', () => {
  const places = parsePhoton({
    features: [
      { geometry: { coordinates: [144.9671, -37.7985] }, properties: { name: 'Lygon Street', city: 'Carlton', state: 'Victoria', country: 'Australia' } },
      { geometry: { coordinates: [144.9668, -37.7991] }, properties: { housenumber: '12', street: 'Lygon Street', district: 'Carlton', city: 'Melbourne', state: 'Victoria', country: 'Australia' } },
      { geometry: { coordinates: [144.9668, -37.7991] }, properties: { housenumber: '12', street: 'Lygon Street', city: 'Melbourne' } },   // same spot and name: dropped
      { geometry: { coordinates: [144.97, -37.8] }, properties: { name: 'Brunetti', street: 'Lygon Street', housenumber: '380', city: 'Carlton', country: 'Australia' } },
      { geometry: { coordinates: ['x', 1] }, properties: { name: 'Broken' } },
      { properties: { name: 'No geometry' } },
      { geometry: { coordinates: [1, 2] }, properties: {} },                       // nothing to call it
    ],
  });
  assert.deepEqual(places.map((p) => [p.name, p.detail]), [
    ['Lygon Street', 'Carlton, Victoria, Australia'],
    ['12 Lygon Street', 'Carlton, Victoria, Australia'],
    ['Brunetti', '380 Lygon Street, Carlton, Australia'],
  ]);
  assert.deepEqual([places[0].lat, places[0].lng], [-37.7985, 144.9671]);     // GeoJSON is [lng, lat]
  assert.deepEqual(parsePhoton(null), []);
  assert.deepEqual(parsePhoton({ features: 'nope' }), []);
});

test('overpass nodes and centred ways become cafés', () => {
  const cafes = parseOverpass({
    elements: [
      { type: 'node', id: 1, lat: -37.8, lon: 144.96, tags: { name: 'Seven Seeds', amenity: 'cafe' } },
      { type: 'way', id: 2, center: { lat: -37.81, lon: 144.97 }, tags: { amenity: 'cafe' } },
      { type: 'node', id: 3, tags: { name: 'No position' } },
      { type: 'node', lat: 1, lon: 2 },
    ],
  });
  assert.deepEqual(cafes, [
    { id: 'node/1', name: 'Seven Seeds', lat: -37.8, lng: 144.96 },
    { id: 'way/2', name: null, lat: -37.81, lng: 144.97 },
  ]);
  assert.deepEqual(parseOverpass({}), []);
});

test('the café box is centred on the grid, half again as big as the view, and survives a small pan', () => {
  const box = cafeBox([-37.805, 144.956, -37.795, 144.976]);
  // centre (-37.8, 144.966) snaps to (-37.8, 144.97); half-sizes 0.0075 and 0.015 round out to 0.01 and 0.02
  assert.deepEqual(box, [-37.81, 144.95, -37.79, 144.99]);
  assert.deepEqual(cafeBox([-37.804, 144.957, -37.794, 144.977]), box);        // a nudge: the same box
  assert.notDeepEqual(cafeBox([-37.805, 144.976, -37.795, 144.996]), box);     // a long pan: the next box
  assert.equal(cafeQuery(box), '[out:json][timeout:10];nwr["amenity"="cafe"](-37.81,144.95,-37.79,144.99);out center 200;');
});

test('the café under a tap, and whether two points are one place', () => {
  const project = (lat: number, lng: number) => ({ x: (lng - 144) * 1000, y: (38 - lat) * 1000 });
  const cafes = [{ id: 'a', name: 'A', lat: 37.5, lng: 144.5 }, { id: 'b', name: 'B', lat: 37.6, lng: 144.6 }];
  assert.equal(nearestCafe(cafes, project, { x: 503, y: 498 })?.id, 'a');
  assert.equal(nearestCafe(cafes, project, { x: 550, y: 450 }), null);
  assert.equal(samePlace({ lat: 37.5, lng: 144.5 }, { lat: 37.50010, lng: 144.5 }), true);     // 11 m
  assert.equal(samePlace({ lat: 37.5, lng: 144.5 }, { lat: 37.5003, lng: 144.5 }), false);     // 33 m
  assert.equal(samePlace(null, { lat: 1, lng: 1 }), false);
});

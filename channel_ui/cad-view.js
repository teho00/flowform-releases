const RAD = Math.PI / 180;
const FULL_TURN = 2 * Math.PI;
const SNAP_DISTANCE = 10;
const CURVE_TOOLS = new Set(['trim', 'split', 'round', 'offset', 'project', 'construction']);
const ARC_TOOLS = new Set(['arc', 'tangent-arc']);
const isSketchSelectionTool = (tool) => tool === 'select' || tool === 'move';
const bypassSketchSnap = (event) => event.shiftKey || event.altKey;
const OPEN_ARCS = new Set(['arc', 'ellipseArc']);
const DEPTH_DRAG_THRESHOLD = 4;
const AXIS_SIZE = 72;
const AXIS_INSET = 12;
const AXIS_BOTTOM = 45;
const AXIS_SPAN = 1.3;
const AXIS_LENGTH = 0.89;
const AXES = [
  ['x', [1, 0, 0], [0.95, 0.43, 0.47, 1]],
  ['y', [0, 1, 0], [0.44, 0.87, 0.62, 1]],
  ['z', [0, 0, 1], [0.42, 0.73, 1, 1]],
];
const PLANE_PATCH = [[0.16, 0.16], [0.57, 0.16], [0.57, 0.57], [0.16, 0.57]];
const REFERENCE_FACETS = [
  ['xy', 0, 1],
  ['yz', 1, 2],
  ['xz', 0, 2],
];
const VIEWS = {
  iso: [-55 * RAD, 30 * RAD],
  top: [-Math.PI / 2, Math.PI / 2],
  front: [-Math.PI / 2, 0],
  right: [0, 0],
  left: [Math.PI, 0],
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const unit = (vector) => {
  const length = Math.hypot(...vector);
  return length > 1e-12 ? vector.map((coordinate) => coordinate / length) : null;
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const sketchNormal = (plane) => cross(plane.x, plane.y);
const worldPoint = (plane, [u, v]) => plane.origin.map((value, axis) => value + u * plane.x[axis] + v * plane.y[axis]);
const XY = {origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0]};
const METRIC = new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 3});
function roundMm(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

const positiveAngle = (angle) => ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;
const polarPoint = (x, y, radius, angle) => [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];

function arcPoint(arc, t) {
  const angle = arc.startAngle + t * arc.sweep;
  return [arc.x + (arc.radius ?? arc.rx) * Math.cos(angle), arc.y + (arc.radius ?? arc.ry) * Math.sin(angle)];
}

function arcThrough(start, through, end) {
  const [a, b] = subtract(through, start), [c, d] = subtract(end, start);
  const divisor = 2 * (a * d - b * c);
  if (Math.abs(divisor) <= 1e-9 * Math.hypot(a, b) * Math.hypot(c, d)) return null;
  const first = a * a + b * b, second = c * c + d * d;
  const offset = [(d * first - b * second) / divisor, (a * second - c * first) / divisor];
  const [x, y] = offset.map((value, axis) => start[axis] + value);
  const startAngle = Math.atan2(-offset[1], -offset[0]);
  const toThrough = positiveAngle(Math.atan2(through[1] - y, through[0] - x) - startAngle);
  const toEnd = positiveAngle(Math.atan2(end[1] - y, end[0] - x) - startAngle);
  return {kind: 'arc', x, y, radius: Math.hypot(...offset), startAngle,
    sweep: toThrough < toEnd ? toEnd : toEnd - FULL_TURN};
}

function tangentArc(start, direction, end) {
  const delta = subtract(end, start), normal = [-direction[1], direction[0]];
  const height = delta[0] * normal[0] + delta[1] * normal[1];
  if (Math.abs(height) < 1e-8) return null;
  const distance = (delta[0] ** 2 + delta[1] ** 2) / (2 * height);
  const [x, y] = start.map((value, axis) => value + distance * normal[axis]);
  const startAngle = Math.atan2(start[1] - y, start[0] - x);
  const endAngle = Math.atan2(end[1] - y, end[0] - x);
  const sense = Math.sign(distance);
  return {kind: 'arc', x, y, radius: Math.abs(distance), startAngle,
    sweep: sense * positiveAngle(sense * (endAngle - startAngle))};
}

function curveEnds(entity) {
  if (entity.kind === 'line') return [[entity.x1, entity.y1], [entity.x2, entity.y2]];
  if (OPEN_ARCS.has(entity.kind)) return [arcPoint(entity, 0), arcPoint(entity, 1)];
  return [];
}

function outwardTangent(entity, endpoint) {
  if (entity.kind === 'line') {
    const ends = curveEnds(entity);
    return unit(subtract(ends[endpoint], ends[1 - endpoint]));
  }
  const angle = entity.startAngle + endpoint * entity.sweep;
  const sense = Math.sign(entity.sweep) * (endpoint ? 1 : -1);
  return [-sense * Math.sin(angle), sense * Math.cos(angle)];
}

function sketchOutline(entity) {
  const {kind, x, y, x1, y1, x2, y2, width, length, radius, rx, ry} = entity;
  if (kind === 'point') return [[x, y]];
  if (kind === 'line') return [[x1, y1], [x2, y2]];
  if (kind === 'rectangle') return [[x, y], [x + width, y], [x + width, y + length], [x, y + length]];
  if (OPEN_ARCS.has(kind)) {
    const divisions = Math.max(4, Math.ceil(64 * Math.abs(entity.sweep) / FULL_TURN));
    return Array.from({length: divisions + 1}, (_, i) => arcPoint(entity, i / divisions));
  }
  return Array.from({length: 64}, (_, i) => {
    const angle = i * Math.PI / 32;
    return [x + Math.cos(angle) * (radius ?? rx), y + Math.sin(angle) * (radius ?? ry)];
  });
}

function sketchEntity(kind, start, end) {
  const [x, y] = start, [u, v] = end;
  if (kind === 'point') return {kind, x: u, y: v};
  if (kind === 'line') return {kind, x1: x, y1: y, x2: u, y2: v};
  const width = Math.abs(x - u), length = Math.abs(y - v);
  if (kind === 'rectangle') return {kind, x: Math.min(x, u), y: Math.min(y, v), width, length};
  if (kind === 'circle') return {kind, x, y, radius: Math.hypot(width, length)};
  return {kind, x, y, rx: width, ry: length};
}

function drawable(entity) {
  if (!entity) return false;
  const {kind, x1, y1, x2, y2, width, length, radius, rx, ry} = entity;
  if (kind === 'point') return true;
  if (kind === 'line') return Math.hypot(x2 - x1, y2 - y1) > 0;
  if (kind === 'rectangle') return width > 0 && length > 0;
  if (kind === 'circle') return radius > 0;
  if (kind === 'arc') return radius >= 0.0001 && radius <= 1_000_000 &&
    Math.abs(entity.sweep) >= 1e-8 && Math.abs(entity.sweep) < FULL_TURN - 1e-8;
  return rx > 0 && ry > 0;
}

function sketchDimensions(entity) {
  const {kind, x, y, x1, y1, x2, y2, width, length, radius, rx, ry} = entity;
  const mm = (value) => METRIC.format(value);
  if (kind === 'point') return 'X ' + mm(x) + ' · Y ' + mm(y) + ' mm';
  if (kind === 'line') return `길이 ${mm(Math.hypot(x2 - x1, y2 - y1))} mm · ${mm(Math.atan2(y2 - y1, x2 - x1) / RAD)}°`;
  if (kind === 'rectangle') return mm(width) + ' × ' + mm(length) + ' mm';
  if (kind === 'circle') return 'R ' + mm(radius) + ' mm';
  if (kind === 'arc') return `R ${mm(radius)} mm · ${mm(Math.abs(entity.sweep) / RAD)}°`;
  return 'Rx ' + mm(rx) + ' · Ry ' + mm(ry) + ' mm';
}

function precisionDimensions(entity) {
  if (!entity) return [];
  const {kind, x, y, x1, y1, x2, y2, width, length, radius, rx, ry} = entity;
  const distance = (value) => ({value, min: 0.0001, max: 1_000_000});
  if (kind === 'point') return [{label: 'X 위치 (mm)', value: x}, {label: 'Y 위치 (mm)', value: y}];
  if (kind === 'line') return [
    {label: '길이 (mm)', ...distance(Math.hypot(x2 - x1, y2 - y1))},
    {label: '각도 (°)', value: Math.atan2(y2 - y1, x2 - x1) / RAD, angular: true},
  ];
  if (kind === 'rectangle') return [{label: '폭 (mm)', ...distance(width)}, {label: '높이 (mm)', ...distance(length)}];
  if (kind === 'ellipse') return [{label: 'X 반지름 (mm)', ...distance(rx)}, {label: 'Y 반지름 (mm)', ...distance(ry)}];
  if (kind === 'arc') return [
    {label: '반지름 (mm)', ...distance(radius)},
    {label: '중심각 (°)', value: Math.abs(entity.sweep) / RAD, min: 0.000001, max: 359.999999, angular: true},
  ];
  return [{label: '반지름 (mm)', ...distance(radius)}];
}

function preciseEntity(gesture, values) {
  const {entity, start, point} = gesture;
  const [first, second] = values;
  if (entity.kind === 'point') return sketchEntity('point', start, values);
  if (entity.kind === 'line') return sketchEntity('line', start, polarPoint(...start, first, second * RAD));
  if (entity.kind === 'arc') {
    const anchor = arcPoint(entity, 0);
    const [x, y] = polarPoint(...anchor, -first, entity.startAngle);
    return {...entity, x, y, radius: first, sweep: Math.sign(entity.sweep) * second * RAD};
  }
  if (entity.kind === 'circle') return {...entity, radius: first};
  const next = values.map((value, axis) => start[axis] + (point[axis] < start[axis] ? -value : value));
  const result = sketchEntity(entity.kind, start, next);
  if (entity.kind === 'rectangle') return {...result, width: first, length: second};
  return {...result, rx: first, ry: second};
}

function nearestSegment(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2, 0, 1) : 0;
  return {t, distance: Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))};
}

function closestCurvePoint(curve, point) {
  if (curve.kind === 'line') {
    const [a, b] = curveEnds(curve);
    const {t} = nearestSegment(point, a, b);
    return a.map((value, axis) => value + (b[axis] - value) * t);
  }
  if (curve.kind === 'circle' || curve.kind === 'ellipse' || OPEN_ARCS.has(curve.kind)) {
    const {x, y, radius, startAngle, sweep} = curve;
    const rx = radius ?? curve.rx, ry = radius ?? curve.ry;
    const angle = Math.atan2((point[1] - y) / ry, (point[0] - x) / rx);
    if (OPEN_ARCS.has(curve.kind)) {
      const sense = Math.sign(sweep);
      if (positiveAngle(sense * (angle - startAngle)) > Math.abs(sweep)) {
        const [a, b] = curveEnds(curve);
        return Math.hypot(...subtract(point, a)) < Math.hypot(...subtract(point, b)) ? a : b;
      }
    }
    return [x + rx * Math.cos(angle), y + ry * Math.sin(angle)];
  }
  if (curve.kind === 'rectangle') {
    const outline = sketchOutline(curve);
    let best, distance = Infinity;
    for (const [index, a] of outline.entries()) {
      const b = outline[(index + 1) % outline.length];
      const hit = nearestSegment(point, a, b);
      if (hit.distance < distance) {
        distance = hit.distance;
        best = a.map((value, axis) => value + (b[axis] - value) * hit.t);
      }
    }
    return best;
  }
  return null;
}

function collectIntersections(segments) {
  const points = new Map();
  for (const {entityId, curve} of segments ?? []) {
    for (const point of curveEnds(curve)) {
      const key = point.map((coordinate) => Math.round(coordinate / 1e-7)).join(',');
      const match = points.get(key);
      if (match) match.entities.add(entityId);
      else points.set(key, {point, entities: new Set([entityId])});
    }
  }
  return [...points.values()].filter(({entities}) => entities.size > 1);
}

function footprint(positions, plane) {
  const triangles = [];
  for (let i = 0; i < positions.length; i += 9) {
    const points = [i, i + 3, i + 6].map((offset) => {
      const relative = subtract(positions.slice(offset, offset + 3), plane.origin);
      return [dot(relative, plane.x), dot(relative, plane.y)];
    });
    const [xs, ys] = [0, 1].map((axis) => points.map((point) => point[axis]));
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (bounds[2] > bounds[0] && bounds[3] > bounds[1]) triangles.push({points, bounds});
  }
  return triangles.sort((first, second) => first.bounds[0] - second.bounds[0]);
}

function triangleOverlap(a, b) {
  for (const triangle of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const p = triangle[i], q = triangle[(i + 1) % 3];
      const [x, y] = [q[1] - p[1], p[0] - q[0]];
      const limit = 1e-8 * Math.hypot(x, y);
      const samples = (points) => points.map((point) => x * (point[0] - p[0]) + y * (point[1] - p[1]));
      const first = samples(a), second = samples(b);
      if (Math.min(Math.max(...first), Math.max(...second)) - Math.max(Math.min(...first), Math.min(...second)) <= limit) {
        return false;
      }
    }
  }
  return true;
}

function footprintsOverlap(first, second) {
  for (const a of first) {
    for (const b of second) {
      if (b.bounds[0] >= a.bounds[2]) break;
      if (b.bounds[2] <= a.bounds[0] || b.bounds[3] <= a.bounds[1] || b.bounds[1] >= a.bounds[3]) continue;
      if (triangleOverlap(a.points, b.points)) return true;
    }
  }
  return false;
}

function resizeSketch(hit, start, next) {
  const {entity, corner, side} = hit;
  const {kind, x, y, x1, y1, x2, y2, width, length, rx, ry} = entity;
  const [u, v] = next;
  if (kind === 'point') return {...entity, x: u, y: v};
  if (kind === 'line') {
    if (corner === 0) return {...entity, x1: u, y1: v};
    if (corner === 1) return {...entity, x2: u, y2: v};
    const [du, dv] = [u - start[0], v - start[1]];
    return {...entity, x1: x1 + du, y1: y1 + dv, x2: x2 + du, y2: y2 + dv};
  }
  if (kind === 'circle' || kind === 'arc') return {...entity, radius: Math.hypot(u - x, v - y)};
  if (kind === 'ellipse' || kind === 'ellipseArc') return Math.abs((start[0] - x) / rx) >= Math.abs((start[1] - y) / ry)
    ? {...entity, rx: Math.abs(u - x)} : {...entity, ry: Math.abs(v - y)};
  const outline = sketchOutline(entity);
  if (corner !== null) return {...entity, ...sketchEntity('rectangle', outline[(corner + 2) % 4], [u, v])};
  const opposite = [x + width, y + length];
  if (side === 0) return {...entity, ...sketchEntity('rectangle', [x, v], opposite)};
  if (side === 1) return {...entity, ...sketchEntity('rectangle', [x, y], [u, opposite[1]])};
  if (side === 2) return {...entity, ...sketchEntity('rectangle', [x, y], [opposite[0], v])};
  return {...entity, ...sketchEntity('rectangle', [u, y], opposite)};
}

function translatedSketch(entity, [dx, dy]) {
  if (entity.kind === 'line') {
    return {...entity, x1: entity.x1 + dx, y1: entity.y1 + dy, x2: entity.x2 + dx, y2: entity.y2 + dy};
  }
  return {...entity, x: entity.x + dx, y: entity.y + dy};
}

const VERTEX = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform vec3 uRight, uUp, uForward, uCenter, uSpan;
uniform vec2 uPan;
uniform float uBias;
varying vec3 vNormal;
varying highp vec3 vWorld;
void main() {
  vWorld = aPosition;
  vec3 p = aPosition - uCenter;
  vec3 view = vec3(dot(p, uRight), dot(p, uUp), -dot(p, uForward));
  gl_Position = vec4((view.xy - uPan) / uSpan.xy, view.z / uSpan.z + uBias, 1.0);
  vNormal = aNormal;
}`;

const FRAGMENT = `
precision highp float;
uniform vec4 uColor;
uniform vec3 uRight, uUp, uForward;
uniform bool uLit;
uniform vec4 uSection;
varying highp vec3 vWorld;
varying vec3 vNormal;
void main() {
  if (dot(vWorld, uSection.xyz) > uSection.w) discard;
  float strength = 1.0;
  if (uLit) {
    vec3 normal = normalize(vNormal);
    if (dot(normal, uForward) < 0.0) normal = -normal;
    vec3 key = normalize(uForward * 0.60 + uUp * 0.75 - uRight * 0.36);
    strength = 0.49 + 0.51 * max(0.0, dot(normal, key));
  }
  gl_FragColor = vec4(uColor.rgb * strength, uColor.a);
}`;

function linkProgram(gl) {
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function uploadMesh(gl, mesh) {
  if (!mesh?.faces.length) return null;
  const vertices = new Float32Array(mesh.faces.reduce((count, face) => count + face.positions.length * 2, 0));
  const ranges = new Map();
  let offset = 0;
  for (const face of mesh.faces) {
    const coordinates = face.positions;
    ranges.set(face.id, [offset / 6, coordinates.length / 3]);
    for (let i = 0; i < coordinates.length; i += 9) {
      const ab = coordinates.slice(i + 3, i + 6).map((value, axis) => value - coordinates[i + axis]);
      const ac = coordinates.slice(i + 6, i + 9).map((value, axis) => value - coordinates[i + axis]);
      const normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const length = Math.hypot(...normal) || 1;
      const unit = normal.map((value) => value / length);
      for (let j = i; j < i + 9; j += 3) {
        vertices.set(coordinates.slice(j, j + 3), offset);
        vertices.set(unit, offset + 3);
        offset += 6;
      }
    }
  }
  const edges = wireCoordinates(mesh);
  function buffer(data) {
    const result = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, result);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return result;
  }
  return {
    mesh, ranges,
    faces: buffer(vertices), faceCount: vertices.length / 6,
    edges: buffer(new Float32Array(edges)), edgeCount: edges.length / 3,
  };
}

function gridSpacing(scale) {
  const target = scale / 9;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const candidates = [1, 2, 5, 10];
  return magnitude * candidates.find((factor) => target <= factor * magnitude);
}

function circularOutline(x, y, z, radius) {
  const coordinates = [];
  for (let i = 0; i < 64; i++) {
    const angle = i * Math.PI / 32;
    coordinates.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, z);
  }
  return coordinates;
}

function wireCoordinates(mesh, bodyId) {
  const values = [];
  for (const [index, line] of (mesh?.edges ?? []).entries()) {
    if (bodyId && mesh.edge_meta?.[index]?.body_id !== bodyId) continue;
    for (let i = 3; i < line.length; i += 3) values.push(...line.slice(i - 3, i + 3));
  }
  return values;
}

export function createViewport(canvas, {
  onPick, onSketch, onChange, onDepthChange, onDepthCommit, onDepthCancel, onSnapChange,
  onSketchCreate, onSketchEdit, onSketchMove, onSketchPull, onSketchSelect, onFillet, onDirectPreview, onDirectCommit, onDimensionPick,
  onSketchToolPick, previewSketchEdit, inspectMesh = false,
} = {}) {
  const gl = canvas.getContext('webgl', {alpha: true, antialias: true});
  if (!gl) throw new Error('이 브라우저에서 WebGL 3D 뷰포트를 열 수 없습니다.');
  const program = linkProgram(gl);
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, 'aPosition');
  const normal = gl.getAttribLocation(program, 'aNormal');
  const uniforms = Object.fromEntries(
    ['Right', 'Up', 'Forward', 'Center', 'Span', 'Pan', 'Bias', 'Color', 'Lit', 'Section']
      .map((name) => [name, gl.getUniformLocation(program, `u${name}`)]),
  );
  const scratch = gl.createBuffer();
  const previewBuffer = gl.createBuffer();
  const wireframeBuffer = inspectMesh ? gl.createBuffer() : null;
  gl.enableVertexAttribArray(position);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  let name = 'iso';
  let [azimuth, elevation] = VIEWS.iso;
  let center = [0, 0, 0];
  let pan = [0, 0];
  let scale = 40;
  let fittedScale = scale;
  let radius = 25;
  let hasFitModel = false;
  let focus = 'part';
  let selection = null;
  let faceHighlights = [];
  let bodySelection = null;
  let previewCount = 0;
  let hovered = null;
  let sketch = null;
  let drag = null;
  let depthTool = null;
  let depthDrag = null;
  let snapEnabled = true;
  let snapTarget = null;
  let frame = null;
  let workspace = {sketches: [], activeId: null, activeRegion: null, tool: 'select', pullMode: 'auto', selectedEntity: null};
  let alignedPlane = null;
  let lineAnchor = null;
  let shapeAnchor = null;
  let arcAnchors = [];
  let tangentStart = null;
  let draftHover = null;
  let lastDraftPointer = null;
  let precision = null;
  let gestureHover = null;
  const intersectionsBySketch = new WeakMap();
  const shapes = {part: null, domain: null};
  let sectionAxis = -1, sectionAt = 0;
  let outlines = {};
  let portCaps = [], markedPorts = [], onPortPick;
  function setSection(axis, coordinate) {
    sectionAxis = axis;
    sectionAt = coordinate;
    outlines = {};
    if (axis >= 0) for (const [layer, shape] of Object.entries(shapes)) {
      const segments = [];
      for (const face of shape?.mesh.faces || []) {
        const p = face.positions;
        for (let i = 0; i < p.length; i += 9) {
          const hits = [];
          for (let edge = 0; edge < 3; edge++) {
            const a = i + edge * 3, b = i + (edge + 1) % 3 * 3;
            const da = p[a + axis] - coordinate, db = p[b + axis] - coordinate;
            if ((da < 0) === (db < 0)) continue;
            const t = da / (da - db);
            hits.push(...[0, 1, 2].map(k => p[a+k] + t * (p[b+k] - p[a+k])));
          }
          if (hits.length === 6) segments.push(...hits);
        }
      }
      outlines[layer] = segments;
    }
    schedule();
  }
  let wireframe = null;
  let wireframeCount = 0;
  const overlay = (id) => canvas.parentElement?.querySelector(`#${id}`);
  const depthHandle = overlay('depth-handle');
  const depthDimension = overlay('depth-dimension');
  const worldOrigin = overlay('world-origin');
  const snapMarker = overlay('snap-marker');
  const cursorValues = overlay('sketch-cursor-values');
  const precisionForm = document.createElement('form');
  precisionForm.className = 'sketch-precision';
  precisionForm.id = 'sketch-precision';
  precisionForm.setAttribute('aria-label', '그리는 중 치수 입력');
  precisionForm.autocomplete = 'off';
  precisionForm.hidden = true;
  if (!inspectMesh) canvas.parentElement?.append(precisionForm);
  const axisLabels = AXES.map(([axis]) => inspectMesh
    ? canvas.parentElement?.querySelector(`[data-view-axis="${axis}"]`) : overlay(`axis-${axis}`));
  const planePicker = overlay('reference-plane-picker');
  const referenceFacets = [];
  for (const [key, first, second] of REFERENCE_FACETS) {
    const facet = planePicker?.querySelector(`[data-plane-facet="${key}"]`);
    const button = planePicker?.querySelector(`button[data-sketch-plane="${key}"]`);
    if (!facet || !button) continue;
    facet.addEventListener('click', () => button.click());
    referenceFacets.push({facet, button, world: PLANE_PATCH.map(([u, v]) => {
      const point = [0, 0, 0];
      point[first] = u;
      point[second] = v;
      return point;
    })});
  }
  canvas.dataset.preview = 'false';

  function activeSketch() {
    return workspace.sketches.find((entry) => entry.id === workspace.activeId);
  }

  function camera() {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const aspect = width / height;
    const right = alignedPlane?.x ?? [-Math.sin(azimuth), Math.cos(azimuth), 0];
    const up = alignedPlane?.y ?? [-Math.sin(elevation) * Math.cos(azimuth), -Math.sin(elevation) * Math.sin(azimuth), Math.cos(elevation)];
    const forward = alignedPlane ? sketchNormal(alignedPlane)
      : [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
    const visibleY = scale / Math.min(aspect, 1);
    const profileDepth = depthTool ? Math.abs(center[2] - depthTool.z) + depthTool.height : 0;
    const workspaceDepth = Math.abs(drag?.value ?? 0);
    const depth = Math.max(radius * 2, scale * 2, profileDepth + radius,
      Math.abs(center[2] - (sketch?.planeZ ?? 0)) + radius * 1.5, workspaceDepth + radius * 2);
    return {width, height, right, up, forward, span: [visibleY * aspect, visibleY, depth]};
  }

  function project(view, point) {
    const relative = point.map((value, axis) => value - center[axis]);
    return [
      (1 + (dot(relative, view.right) - pan[0]) / view.span[0]) * view.width / 2,
      (1 - (dot(relative, view.up) - pan[1]) / view.span[1]) * view.height / 2,
    ];
  }

  function positionOverlay(element, point) {
    if (!element) return;
    element.hidden = point === null;
    if (point === null) return;
    element.style.left = `${point[0]}px`;
    element.style.top = `${point[1]}px`;
  }

  function visible(view, point, inset = 0) {
    return point[0] >= inset && point[0] <= view.width - inset &&
      point[1] >= inset && point[1] <= view.height - inset;
  }

  function change() {
    onChange?.({view: name, zoom: Math.round(fittedScale / scale * 100), sketch, gridStep: gridStep(camera())});
    schedule();
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(draw);
  }

  function applyCamera(view, origin = center, shift = pan) {
    gl.uniform3fv(uniforms.Right, view.right);
    gl.uniform3fv(uniforms.Up, view.up);
    gl.uniform3fv(uniforms.Forward, view.forward);
    gl.uniform3fv(uniforms.Center, origin);
    gl.uniform3fv(uniforms.Span, view.span);
    gl.uniform2fv(uniforms.Pan, shift);
  }

  function paint(buffer, first, count, mode, color, bias = 0) {
    const lit = mode === gl.TRIANGLES;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, lit ? 24 : 0, 0);
    if (lit) {
      gl.enableVertexAttribArray(normal);
      gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12);
    } else {
      gl.disableVertexAttribArray(normal);
    }
    gl.uniform1i(uniforms.Lit, lit);
    gl.uniform4fv(uniforms.Color, color);
    gl.uniform1f(uniforms.Bias, bias);
    gl.drawArrays(mode, first, count);
  }

  function lines(coordinates, color, bias = 0, mode = gl.LINES) {
    if (!coordinates.length) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(coordinates), gl.DYNAMIC_DRAW);
    paint(scratch, 0, coordinates.length / 3, mode, color, bias);
  }

  function gridStep(view) {
    return gridSpacing(Math.max(view.span[0], view.span[1]));
  }

  function drawGrid(view) {
    const step = gridStep(view);
    const reach = Math.max(...view.span.slice(0, 2)) * 1.65;
    const plane = activeSketch()?.plane ?? (name === 'plane' ? alignedPlane : null) ??
      {...XY, origin: [0, 0, sketch?.planeZ ?? 0]};
    const visibleCenter = center.map((value, axis) => value + pan[0] * view.right[axis] + pan[1] * view.up[axis]);
    const relative = subtract(visibleCenter, plane.origin);
    const x = dot(relative, plane.x), y = dot(relative, plane.y);
    const xmin = Math.floor((x - reach) / step), xmax = Math.ceil((x + reach) / step);
    const ymin = Math.floor((y - reach) / step), ymax = Math.ceil((y + reach) / step);
    const major = [], minor = [];
    for (let i = xmin; i <= xmax; i++) {
      if (i === 0) continue;
      (i % 5 === 0 ? major : minor).push(...worldPoint(plane, [i * step, ymin * step]), ...worldPoint(plane, [i * step, ymax * step]));
    }
    for (let i = ymin; i <= ymax; i++) {
      if (i === 0) continue;
      (i % 5 === 0 ? major : minor).push(...worldPoint(plane, [xmin * step, i * step]), ...worldPoint(plane, [xmax * step, i * step]));
    }
    lines(minor, [0.16, 0.23, 0.33, 0.66], 0.0002);
    lines(major, [0.25, 0.34, 0.47, 0.73], 0.0002);
    if (ymin <= 0 && ymax >= 0) lines([...worldPoint(plane, [xmin * step, 0]), ...worldPoint(plane, [xmax * step, 0])], [0.69, 0.32, 0.37, 0.67], 0.0002);
    if (xmin <= 0 && xmax >= 0) lines([...worldPoint(plane, [0, ymin * step]), ...worldPoint(plane, [0, ymax * step])], [0.35, 0.68, 0.51, 0.67], 0.0002);
  }

  function drawShape(layer, ghost = false) {
    const shape = shapes[layer];
    if (!shape) return;
    if (inspectMesh) {
      for (const face of shape.mesh.faces) {
        paint(shape.faces, ...shape.ranges.get(face.id), gl.TRIANGLES, face.color);
      }
      paint(shape.edges, 0, shape.edgeCount, gl.LINES, [0.05, 0.12, 0.19, 0.92], -0.00028);
      return;
    }
    const domain = layer === 'domain';
    const baseColor = domain ? [0.19, 0.75, 0.65, 1] : [0.40, 0.63, 0.88, ghost ? 0.18 : 1];
    gl.depthMask(!ghost);
    paint(shape.faces, 0, shape.faceCount, gl.TRIANGLES, baseColor);
    if (layer === 'part' && bodySelection) {
      for (const face of shape.mesh.faces) {
        if (face.body_id === bodySelection) {
          paint(shape.faces, ...shape.ranges.get(face.id), gl.TRIANGLES, [0.34, 0.86, 0.95, 0.24], -0.00008);
        }
      }
    }
    const active = layer === (focus === 'domain' ? 'domain' : 'part');
    if (active) {
      const hoverRange = shape.ranges.get(hovered);
      const selectedRange = shape.ranges.get(selection);
      if (hoverRange) paint(shape.faces, ...hoverRange, gl.TRIANGLES, [0.60, 0.85, 1, 0.86], -0.00012);
      if (selectedRange) paint(shape.faces, ...selectedRange, gl.TRIANGLES, [1, 0.74, 0.39, 1], -0.00018);
      for (const {id, color} of faceHighlights) {
        const range = shape.ranges.get(id);
        if (range) paint(shape.faces, ...range, gl.TRIANGLES, color, -0.00021);
      }
    }
    if (shape.edgeCount) {
      paint(shape.edges, 0, shape.edgeCount, gl.LINES, [0.07, 0.14, 0.22, ghost ? 0.42 : 0.92], -0.00045);
    }
    gl.depthMask(true);
  }

  function setPreview(model) {
    const mesh = model?.part;
    const bodyId = drag?.operation?.body;
    const edges = wireCoordinates(mesh, mesh?.edge_meta?.some((edge) => edge?.body_id === bodyId) ? bodyId : null);
    previewCount = edges.length / 3;
    canvas.dataset.preview = String(previewCount > 0);
    if (previewCount) {
      gl.bindBuffer(gl.ARRAY_BUFFER, previewBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edges), gl.DYNAMIC_DRAW);
    }
    schedule();
  }

  function drawDirectPreview() {
    if (!previewCount) return;
    gl.disable(gl.DEPTH_TEST);
    paint(previewBuffer, 0, previewCount, gl.LINES, [0.45, 0.97, 1, 0.92]);
    gl.enable(gl.DEPTH_TEST);
  }

  function drawSketch() {
    if (drag?.kind !== 'sketch' || !drag.end) return;
    const [x, y] = drag.start;
    const [endX, endY] = drag.end;
    const z = sketch.planeZ;
    const coordinates = sketch.profile === 'circle'
      ? circularOutline(x, y, z, Math.hypot(endX - x, endY - y))
      : [x, y, z, endX, y, z, endX, endY, z, x, endY, z];
    gl.disable(gl.DEPTH_TEST);
    lines(coordinates, [0.38, 0.88, 0.98, 1], 0, gl.LINE_LOOP);
    gl.enable(gl.DEPTH_TEST);
  }

  function drawEntity(plane, entity, color) {
    const outline = sketchOutline(entity);
    if (entity.kind === 'point') {
      const view = camera();
      const size = 5 * view.span[1] / view.height;
      const {x, y} = entity;
      lines([[x - size, y], [x + size, y], [x, y - size], [x, y + size]]
        .flatMap((point) => worldPoint(plane, point)), color);
      return;
    }
    const coordinates = outline.map((point) => worldPoint(plane, point));
    if (entity.construction && (entity.kind === 'line' || entity.kind === 'circle' ||
        entity.kind === 'ellipse' || OPEN_ARCS.has(entity.kind))) {
      const view = camera();
      const spacing = 12 * view.span[1] / view.height;
      const arc = OPEN_ARCS.has(entity.kind) ? entity : {startAngle: 0, sweep: FULL_TURN, ...entity};
      const length = entity.kind === 'line' ? Math.hypot(...subtract(outline[1], outline[0]))
        : Math.abs(arc.sweep) * (arc.radius ?? Math.max(arc.rx, arc.ry));
      const count = clamp(Math.ceil(length / spacing), 1, 192);
      const point = entity.kind === 'line'
        ? (t) => outline[0].map((value, axis) => value + t * (outline[1][axis] - value))
        : (t) => arcPoint(arc, t);
      const dashed = [];
      for (let index = 0; index < count; index++) {
        dashed.push(...worldPoint(plane, point(index / count)), ...worldPoint(plane, point((index + 0.58) / count)));
      }
      lines(dashed, color);
      return;
    }
    const mode = OPEN_ARCS.has(entity.kind) ? gl.LINE_STRIP : entity.kind === 'line' ? gl.LINES : gl.LINE_LOOP;
    lines(coordinates.flat(), color, 0, mode);
  }

  function fillRegion(positions, normalDirection, color) {
    if (!positions.length) return;
    const vertices = new Float32Array(positions.length * 2);
    for (let i = 0; i < positions.length; i += 3) {
      vertices.set(positions.slice(i, i + 3), i * 2);
      vertices.set(normalDirection, i * 2 + 3);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    paint(scratch, 0, positions.length / 3, gl.TRIANGLES, color);
  }

  function channelForOutline(entry, entityIds) {
    if (!entityIds?.length) return null;
    return entry.editableChannels?.find((channel) => entityIds.every((id) => channel.outlineIds.includes(id))) ?? null;
  }

  function linkedSketchPreview(gesture) {
    if (gesture?.kind !== 'work-edit' || gesture.translate || !drawable(gesture.entity)) return null;
    const next = previewSketchEdit?.(gesture.entry.id, gesture.hit.entity.id, gesture.entity);
    if (!next) return null;
    const previous = new Map(gesture.entry.entities.map((entity) => [entity.id, entity]));
    return next.filter((entity) => {
      const original = previous.get(entity.id);
      return !original || Object.keys(original).length !== Object.keys(entity).length ||
        Object.keys(entity).some((key) => entity[key] !== original[key]);
    });
  }

  function drawWorkspace() {
    if (!workspace.sketches.length) return;
    const current = activeSketch();
    const linked = linkedSketchPreview(drag);
    const changed = new Set(linked?.map((entity) => entity.id));
    const preview = linked || drag?.channel ? null : precision?.entity ?? drag?.entity ?? draftHover?.entity;
    gl.disable(gl.DEPTH_TEST);
    for (const entry of current ? [current] : workspace.sketches) {
      const active = entry === current;
      const selected = workspace.selectedEntity?.sketchId === entry.id ? workspace.selectedEntity.entityId : null;
      const hidden = new Set(entry.hiddenEntityIds ?? []);
      const hotRegion = gestureHover?.kind === 'work-pull' && gestureHover.entry === entry ? gestureHover.region : null;
      const moving = drag?.kind === 'work-move' && drag.entry === entry ? drag : null;
      const selectedProfile = active && entry.profiles?.find((profile) => profile.id === workspace.activeRegion);
      const hotProfile = active && gestureHover?.kind === 'work-move' ? gestureHover.region : null;
      const inspectedChannel = active && entry.editableChannels?.find((channel) => channel.id === workspace.channelSelection);
      const channelOutline = active ? (gestureHover?.channel ?? inspectedChannel)?.outlineIds : null;
      const movingPlane = moving ? {...entry.plane, origin: worldPoint(entry.plane, moving.offset)} : null;
      if (active) {
        const shift = movingPlane ? subtract(movingPlane.origin, entry.plane.origin) : null;
        for (const profile of entry.profiles ?? []) {
          if (profile.entityIds?.some((id) => changed.has(id) || (preview && drag?.hit?.entity.id === id))) continue;
          const moved = moving?.region.id === profile.id;
          const highlighted = moved || (!moving && (profile === selectedProfile || profile === hotProfile));
          if (!highlighted && profile.entityIds?.every((id) => hidden.has(id))) continue;
          const positions = moved ? profile.positions.map((value, index) => value + shift[index % 3]) : profile.positions;
          const fill = highlighted ? [0.96, 0.68, 0.29, 0.35] : [0.25, 0.77, 0.93, 0.20];
          fillRegion(positions, sketchNormal(entry.plane), fill);
        }
      } else if (hotRegion || !shapes.part) {
        for (const region of entry.regions || []) {
          if (region === hotRegion || !shapes.part) {
            fillRegion(region.positions, sketchNormal(entry.plane), [0.25, 0.77, 0.93, region === hotRegion ? 0.44 : 0.20]);
          }
        }
      }
      const color = [0.43, 0.88, 1, active ? 1 : 0.52];
      for (const region of entry.regions || []) {
        if (region.entityIds.some((id) => changed.has(id))) continue;
        if (moving && moving.region.entityIds.some((id) => region.entityIds.includes(id))) continue;
        for (const outline of region.outlines ?? []) lines(outline, color, 0, gl.LINE_STRIP);
      }
      for (const entity of entry.entities || []) {
        if (!active && entity.construction) continue;
        const inSelected = selectedProfile?.entityIds?.includes(entity.id);
        const inMove = moving?.entityIds.includes(entity.id);
        const inChannel = channelOutline?.includes(entity.id);
        if (changed.has(entity.id) || (hidden.has(entity.id) && !inSelected && !inMove && !inChannel) ||
            (preview && drag?.hit?.entity === entity)) continue;
        const hot = gestureHover?.kind === 'work-edit' && gestureHover.hit.entity === entity ||
          workspace.toolTarget?.entityId === entity.id && !workspace.toolTarget.curve;
        const tint = inChannel ? [0.55, 0.91, 0.75, 1] : entity.construction ? [0.64, 0.73, 0.84, 0.8] : color;
        drawEntity(inMove ? movingPlane : entry.plane, entity,
          hot || selected === entity.id || inSelected || inMove ? [1, 0.77, 0.40, 1] : tint);
      }
      if (active && !drag && (isSketchSelectionTool(workspace.tool) || CURVE_TOOLS.has(workspace.tool))) {
        for (const [x, y] of entry.openPoints ?? []) {
          drawEntity(entry.plane, {kind: 'point', x, y}, [1, 0.34, 0.32, 0.92]);
        }
      }
    }
    if (linked) {
      for (const entity of linked) drawEntity(drag.entry.plane, entity, [1, 0.77, 0.40, 1]);
    }
    if (preview && (drag?.entry || current)) drawEntity((drag?.entry || current).plane, preview, [1, 0.77, 0.40, 1]);
    if (current && workspace.toolTarget?.curve) {
      drawEntity(current.plane, workspace.toolTarget.curve, [1, 0.77, 0.40, 1]);
    }
    if (current && tangentStart) drawEntity(current.plane, tangentStart.curve, [0.55, 0.91, 0.75, 1]);
    if (current) {
      for (const [x, y] of arcAnchors) drawEntity(current.plane, {kind: 'point', x, y}, [1, 0.77, 0.40, 1]);
    }
    if (current && gestureHover?.kind === 'work-tool') {
      const tint = workspace.tool === 'trim' ? [1, 0.34, 0.32, 1] : [1, 0.77, 0.40, 1];
      const {curve, edge} = gestureHover.target;
      if (curve) drawEntity(current.plane, curve, tint);
      if (edge) lines(edge.points, tint, -0.001, gl.LINE_STRIP);
    }
    if (drag?.kind === 'work-pull' && drag.value && !previewCount) {
      const {entry, region, value} = drag;
      const outward = sketchNormal(entry.plane);
      const next = {...entry.plane, origin: entry.plane.origin.map((valueAtAxis, axis) => valueAtAxis + value * outward[axis])};
      const cutting = drag.mode === 'cut' || (drag.mode === 'auto' && value < 0 && shapes.part);
      const color = cutting ? [1, 0.69, 0.42, 0.95] : [0.43, 0.88, 1, 0.95];
      if (region.outlines?.length) {
        for (const outline of region.outlines) {
          const top = outline.map((coordinate, i) => coordinate + value * outward[i % 3]);
          lines(top, color, 0, gl.LINE_STRIP);
          lines([...outline.slice(0, 3), ...top.slice(0, 3)], color);
        }
      } else {
        for (const entity of entry.entities) {
          if (!region.entityIds?.includes(entity.id)) continue;
          drawEntity(next, entity, color);
          const points = sketchOutline(entity);
          const step = Math.max(1, Math.floor(points.length / 4));
          for (let i = 0; i < points.length; i += step) {
            lines([...worldPoint(entry.plane, points[i]), ...worldPoint(next, points[i])], color);
          }
        }
      }
    }
    gl.enable(gl.DEPTH_TEST);
  }

  function drawFilletEdge() {
    const edge = drag?.kind === 'work-fillet' ? drag.edge : gestureHover?.edge;
    if (edge?.points) lines(edge.points, [1, 0.77, 0.40, 1], -0.001, gl.LINE_STRIP);
  }

  function showCursorValues(event, message) {
    if (!cursorValues) return;
    if (!event || !message) {
      positionOverlay(cursorValues, null);
      return;
    }
    cursorValues.textContent = message;
    cursorValues.hidden = false;
    positionNearPointer(cursorValues, event);
  }

  function positionNearPointer(element, event) {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const x = px + 16 + width <= rect.width ? px + 16 : px - width - 16;
    const y = py + 16 + height <= rect.height ? py + 16 : py - height - 16;
    positionOverlay(element, [clamp(x, 4, Math.max(4, rect.width - width - 4)),
      clamp(y, 4, Math.max(4, rect.height - height - 4))]);
  }

  function draftGesture(event, entry, held = null) {
    const {tool} = workspace;
    const anchor = held?.start ?? (tool === 'line' ? lineAnchor : shapeAnchor);
    const point = localPoint(event, entry, null, true, tool === 'line' ? anchor : null);
    if (!point) return null;
    if (ARC_TOOLS.has(tool)) {
      const entity = tool === 'arc' && arcAnchors.length === 2
        ? arcThrough(...arcAnchors, point)
        : tool === 'tangent-arc' && tangentStart ? tangentArc(tangentStart.point, tangentStart.direction, point) : null;
      return {kind: 'work-arc', entry, point, entity: drawable(entity) ? entity : null};
    }
    const start = anchor ?? point;
    return {kind: 'work-create', entry, start, point, entity: sketchEntity(tool, start, point), anchored: Boolean(anchor)};
  }

  function showDraftValues(event, gesture) {
    if (gesture.entity && drawable(gesture.entity)) {
      const snapLabels = {horizontal: '수평', vertical: '수직', intersection: '교차점', endpoint: '끝점',
        midpoint: '중점', center: '중심', origin: '원점', grid: '격자', curve: '곡선'};
      const snap = snapLabels[snapTarget?.kind];
      showCursorValues(event, (snap ? snap + ' · ' : '') + sketchDimensions(gesture.entity));
    } else if (gesture.kind === 'work-arc') {
      const hint = workspace.tool === 'tangent-arc' ?
        (tangentStart ? '호의 끝점 선택' : '접선이 이어질 선·호 끝점 선택')
        : ['호의 시작점 선택', '호가 지나갈 점 선택', '호의 끝점 선택'][arcAnchors.length];
      showCursorValues(event, hint);
    } else {
      showCursorValues(event, sketchDimensions(gesture.entity));
    }
  }

  function tangentReference(entry, event) {
    const view = camera(), pixel = viewPoint(event);
    let closest = null, limit = SNAP_DISTANCE;
    for (const entity of entry.entities ?? []) {
      if (entity.kind !== 'line' && entity.kind !== 'arc') continue;
      for (const [index, point] of curveEnds(entity).entries()) {
        const distance = Math.hypot(...subtract(project(view, worldPoint(entry.plane, point)), pixel));
        if (distance > limit) continue;
        const direction = outwardTangent(entity, index);
        if (!direction) continue;
        limit = distance;
        closest = {point, direction, curve: entity};
      }
    }
    return closest;
  }

  function commitDraftEntity(entity) {
    if (entity.kind === 'line') lineAnchor = [entity.x2, entity.y2];
    shapeAnchor = null;
    arcAnchors = [];
    tangentStart = null;
    draftHover = null;
    showCursorValues(null);
    onSketchCreate?.(entity);
  }

  function closePrecision(restoreFocus = false) {
    precision = null;
    precisionForm.hidden = true;
    precisionForm.replaceChildren();
    if (restoreFocus) canvas.focus({preventScroll: true});
    schedule();
  }

  function updatePrecision() {
    if (!precision) return;
    const {gesture, fields} = precision;
    const valid = fields.every((field) => field.validity.valid && Number.isFinite(field.valueAsNumber));
    precision.entity = valid ? preciseEntity(gesture, fields.map((field) => field.valueAsNumber)) : null;
    schedule();
  }

  function precisionDraft() {
    const entry = activeSketch();
    if (!entry || CURVE_TOOLS.has(workspace.tool) || isSketchSelectionTool(workspace.tool) || !lastDraftPointer) return null;
    const draft = drag?.kind === 'work-create' || drag?.kind === 'work-arc' ? drag
      : draftGesture(lastDraftPointer, entry);
    if (!draft?.entity || draft.kind === 'work-create' && !drag && !draft.anchored && draft.entity.kind !== 'point') return null;
    return draft;
  }

  function openPrecision(event, draft = precisionDraft()) {
    if (!draft || precision) return false;
    const fields = precisionDimensions(draft.entity).map(({label, value, min, max}) => {
      const group = document.createElement('label');
      group.textContent = label;
      const field = document.createElement('input');
      field.type = 'number';
      field.step = 'any';
      field.required = true;
      if (min !== undefined) field.min = String(min);
      if (max !== undefined) field.max = String(max);
      field.value = String(value);
      group.append(field);
      precisionForm.append(group);
      return field;
    });
    if (!fields.length) return false;
    const actions = document.createElement('div');
    actions.className = 'sketch-precision-actions';
    const submit = document.createElement('button'), cancel = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = '적용';
    cancel.type = 'button';
    cancel.textContent = '취소';
    cancel.addEventListener('click', () => closePrecision(true));
    actions.append(submit, cancel);
    precisionForm.append(actions);
    const captured = drag?.id;
    if (captured !== undefined) {
      if (draft.kind === 'work-create' && draft.entity.kind !== 'point') {
        if (draft.entity.kind === 'line') lineAnchor = draft.start;
        else shapeAnchor = draft.start;
      }
      drag = null;
      if (canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured);
    }
    draftHover = null;
    setSnapTarget(null);
    showCursorValues(null);
    precision = {gesture: draft, fields, entity: draft.entity};
    precisionForm.hidden = false;
    positionNearPointer(precisionForm, lastDraftPointer);
    if (/^[0-9]$/.test(event.key)) fields[0].value = event.key;
    fields[0].focus({preventScroll: true});
    if (event.key === ' ') fields[0].select();
    updatePrecision();
    return true;
  }

  function nudgePrecision(event) {
    if (!event.shiftKey || event.metaKey || (event.ctrlKey && event.altKey)) return false;
    const key = event.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return false;
    const primary = key === 'ArrowUp' || key === 'ArrowDown';
    const index = primary ? 0 : 1;
    const draft = precision?.gesture ?? precisionDraft();
    const dimension = precisionDimensions(draft?.entity)[index];
    if (!dimension || (!precision && !openPrecision(event, draft))) return false;
    const field = precision.fields[index];
    const value = Number.isFinite(field.valueAsNumber) ? field.valueAsNumber : dimension.value;
    const multiplier = event.ctrlKey ? 10 : event.altKey ? 0.1 : 1;
    const sign = key === 'ArrowUp' || key === 'ArrowRight' ? 1 : -1;
    const step = (dimension.angular ? 1 : 0.1) * multiplier;
    const next = Number((value + sign * step).toFixed(12));
    field.value = String(clamp(next, dimension.min ?? -Infinity, dimension.max ?? Infinity));
    updatePrecision();
    return true;
  }

  precisionForm.addEventListener('input', updatePrecision);
  precisionForm.addEventListener('keydown', (event) => {
    if (nudgePrecision(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePrecision(true);
  });
  precisionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    updatePrecision();
    const entity = precision?.entity;
    if (!drawable(entity)) return;
    closePrecision(true);
    commitDraftEntity(entity);
  });

  function depthDirection() {
    return depthTool.type === 'cut' ? -1 : 1;
  }

  function depthPoints() {
    const {profile, x, y, z, width, length, height} = depthTool;
    const start = profile === 'rectangle' ? [x + width / 2, y + length / 2, z] : [x, y, z];
    const end = [start[0], start[1], z + depthDirection() * height];
    return {start, end};
  }

  function drawDepth() {
    if (!depthTool || activeSketch()) return;
    const {profile, x, y, z, width, length, radius: profileRadius} = depthTool;
    const {start, end} = depthPoints();
    const base = profile === 'circle'
      ? circularOutline(x, y, z, profileRadius)
      : [x, y, z, x + width, y, z, x + width, y + length, z, x, y + length, z];
    const top = base.map((coordinate, index) => index % 3 === 2 ? end[2] : coordinate);
    const vertical = [...start, ...end];
    for (let i = 0; i < base.length; i += base.length / 4) {
      vertical.push(...base.slice(i, i + 3), ...top.slice(i, i + 3));
    }
    const color = depthTool.type === 'cut' ? [1, 0.64, 0.37, 0.94] : [0.38, 0.88, 0.98, 0.94];
    gl.disable(gl.DEPTH_TEST);
    lines(base, color, 0, gl.LINE_LOOP);
    lines(top, color, 0, gl.LINE_LOOP);
    lines(vertical, color);
    gl.enable(gl.DEPTH_TEST);
  }

  function drawAxes(view, dpr) {
    const size = Math.round(AXIS_SIZE * dpr);
    const inset = Math.round(AXIS_INSET * dpr);
    gl.viewport(inset, Math.round(AXIS_BOTTOM * dpr), size, size);
    gl.disable(gl.DEPTH_TEST);
    applyCamera({...view, span: [AXIS_SPAN, AXIS_SPAN, AXIS_SPAN]}, [0, 0, 0], [0, 0]);
    const pixels = AXIS_SIZE / (2 * AXIS_SPAN);
    const projectAxisPoint = (point) => [pixels * dot(point, view.right), -pixels * dot(point, view.up)];
    AXES.forEach(([, axis, color], index) => {
      const tip = axis.map((coordinate) => coordinate * AXIS_LENGTH);
      lines([0, 0, 0, ...tip], color);
      const [dx, dy] = projectAxisPoint(tip);
      const length = Math.hypot(dx, dy);
      const [labelX, labelY] = length < 5
        ? [-11, 11]
        : [dx + dx * 8 / length, dy + dy * 8 / length];
      positionOverlay(axisLabels[index], [AXIS_INSET + AXIS_SIZE / 2 + labelX,
        view.height - AXIS_BOTTOM - AXIS_SIZE / 2 + labelY]);
    });
    for (const {facet, button, world} of referenceFacets) {
      const projected = world.map(projectAxisPoint);
      const [[x, y], [u, v], , [s, t]] = projected;
      const area = Math.abs((u - x) * (t - y) - (v - y) * (s - x));
      facet.toggleAttribute('hidden', area < 12);
      facet.setAttribute('points', projected.map(([x, y]) => `${x + AXIS_SIZE / 2},${y + AXIS_SIZE / 2}`).join(' '));
      facet.dataset.active = button.getAttribute('aria-pressed');
    }
    gl.enable(gl.DEPTH_TEST);
  }

  function depthPixels(view) {
    const sign = depthDirection();
    return [sign * view.right[2] * view.width / (2 * view.span[0]),
      -sign * view.up[2] * view.height / (2 * view.span[1])];
  }

  function drawOverlays(view) {
    const origin = project(view, [0, 0, 0]);
    if (worldOrigin) worldOrigin.dataset.side = view.width - origin[0] < 92 ? 'left' : 'right';
    positionOverlay(worldOrigin, visible(view, origin, 8) ? origin : null);
    const marker = snapTarget?.world ? project(view, snapTarget.world)
      : sketch && snapTarget ? project(view, [...snapTarget.point, sketch.planeZ]) : null;
    positionOverlay(snapMarker, marker && visible(view, marker, 4) ? marker : null);
    const canDrag = depthTool && !activeSketch() && Math.abs(view.up[2]) > 0.06;
    if (!canDrag) {
      positionOverlay(depthHandle, null);
      positionOverlay(depthDimension, null);
      return;
    }
    const [x, y] = project(view, depthPoints().end);
    const handle = [clamp(x, 22, view.width - 22), clamp(y, 22, view.height - 22)];
    positionOverlay(depthHandle, handle);
    const label = `${depthTool.height.toLocaleString('ko-KR', {maximumFractionDigits: 3})} mm`;
    if (depthDimension && depthDimension.textContent !== label) depthDimension.textContent = label;
    const offset = handle[0] + 100 < view.width ? 57 : -57;
    positionOverlay(depthDimension, [clamp(handle[0] + offset, 47, view.width - 47), handle[1]]);
  }

  function setSnapTarget(target) {
    const before = snapTarget?.kind ?? null;
    snapTarget = target;
    const after = target?.kind ?? null;
    if (before !== after) onSnapChange?.(after);
    schedule();
  }

  function snapPoint(view, point, z) {
    if (!snapEnabled) return point;
    const pixel = project(view, [...point, z]);
    const near = (target) => {
      const projected = project(view, [...target, z]);
      return Math.hypot(projected[0] - pixel[0], projected[1] - pixel[1]) <= SNAP_DISTANCE;
    };
    const origin = [0, 0];
    if (near(origin)) {
      setSnapTarget({point: origin, kind: 'origin'});
      return origin;
    }
    const step = gridStep(view);
    const intersection = point.map((value) => Math.round(value / step) * step);
    if (near(intersection)) {
      setSnapTarget({point: intersection, kind: 'grid'});
      return intersection;
    }
    setSnapTarget(null);
    return point;
  }

  function updateDepth(event) {
    const {start, direction, pixelsPerMm, height: initialHeight} = depthDrag;
    const motion = (event.clientX - start[0]) * direction[0] + (event.clientY - start[1]) * direction[1];
    const height = roundMm(clamp(initialHeight + motion / pixelsPerMm, 0.001, 1_000_000));
    if (depthTool.height !== height) {
      depthTool = {...depthTool, height};
      onDepthChange?.(height);
      schedule();
    }
    showCursorValues(event, (depthTool.type === 'cut' ? '깊이 ' : '높이 ') + METRIC.format(height) + ' mm');
    return Math.abs(motion) >= DEPTH_DRAG_THRESHOLD && height !== initialHeight;
  }

  function cancelDepthDrag() {
    if (!depthDrag) return;
    const {id, height} = depthDrag;
    depthDrag = null;
    if (depthHandle.hasPointerCapture(id)) depthHandle.releasePointerCapture(id);
    depthTool = {...depthTool, height};
    onDepthCancel?.(height);
    showCursorValues(null);
    schedule();
  }

  function draw() {
    frame = null;
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    const view = camera();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(view.width * dpr), height = Math.round(view.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    applyCamera(view);
    gl.depthMask(false);
    if (!inspectMesh) drawGrid(view);
    if (wireframeCount) paint(wireframeBuffer, 0, wireframeCount, gl.LINES, [0.54, 0.68, 0.83, 0.38]);
    gl.depthMask(true);
    if (sectionAxis >= 0) gl.uniform4f(uniforms.Section, +(sectionAxis === 0), +(sectionAxis === 1), +(sectionAxis === 2), sectionAt);
    if (focus !== 'part') drawShape('domain');
    if (focus !== 'domain') drawShape('part', sectionAxis >= 0 || (focus === 'both' && !!shapes.domain));
    if (sectionAxis >= 0) {
      gl.uniform4f(uniforms.Section, 0, 0, 0, 0);
      if (focus !== 'domain') lines(outlines.part || [], [0.99, 0.79, 0.45, 1], -0.0005);
      if (focus !== 'part') lines(outlines.domain || [], [0.49, 1, 0.85, 1], -0.0007);
      drawAxes(view, dpr);
      drawOverlays(view);
      return;
    }
    if (portCaps.length) {
      gl.disable(gl.DEPTH_TEST);
      for (const cap of portCaps) for (const edge of cap.edges)
        lines(edge, markedPorts.includes(cap.ref) ? [1,0.78,0.2,1] : [0.2,0.95,0.9,1], 0, gl.LINE_STRIP);
      gl.enable(gl.DEPTH_TEST);
    }
    drawSketch();
    drawDepth();
    drawWorkspace();
    drawFilletEdge();
    drawDirectPreview();
    drawAxes(view, dpr);
    drawOverlays(view);
  }

  function visibleBounds() {
    const bounds = Object.entries(shapes)
      .filter(([layer, shape]) => shape && (focus === 'both' || layer === focus))
      .map(([, shape]) => shape.mesh.bounds);
    if (wireframe) bounds.push(wireframe.bounds);
    if (!bounds.length) return null;
    return [0, 1, 2, 3, 4, 5].map((axis) => {
      const values = bounds.map((value) => value[axis]);
      return axis < 3 ? Math.min(...values) : Math.max(...values);
    });
  }

  function fit() {
    const bounds = visibleBounds() ?? sketchBounds();
    center = bounds ? bounds.slice(0, 3).map((value, axis) => (value + bounds[axis + 3]) / 2) : [0, 0, 0];
    radius = bounds ? Math.hypot(...bounds.slice(0, 3).map((value, axis) => (bounds[axis + 3] - value) / 2)) : 25;
    let fitRadius = radius;
    if (inspectMesh && bounds) {
      const view = camera();
      const aspect = view.width / view.height;
      const half = bounds.slice(0, 3).map((value, axis) => (bounds[axis + 3] - value) / 2);
      const horizontal = dot(half, view.right.map(Math.abs));
      const vertical = dot(half, view.up.map(Math.abs));
      fitRadius = Math.max(horizontal / aspect, vertical) * Math.min(aspect, 1);
    }
    scale = fittedScale = bounds ? Math.max(fitRadius * 1.18, 0.001) : 40;
    pan = [0, 0];
    change();
  }

  function goToOrigin() {
    const view = camera();
    pan = [-dot(center, view.right), -dot(center, view.up)];
    change();
  }

  function sketchBounds() {
    let bounds = null;
    for (const entry of workspace.sketches) {
      for (const entity of entry.entities || []) {
        if (entry.id !== workspace.activeId && entity.construction) continue;
        for (const local of sketchOutline(entity)) {
          const world = worldPoint(entry.plane, local);
          bounds ??= [...world, ...world];
          for (let axis = 0; axis < 3; axis++) {
            bounds[axis] = Math.min(bounds[axis], world[axis]);
            bounds[axis + 3] = Math.max(bounds[axis + 3], world[axis]);
          }
        }
      }
    }
    return bounds;
  }

  function setView(next) {
    if (activeSketch() || !Object.hasOwn(VIEWS, next)) return;
    name = next;
    [azimuth, elevation] = VIEWS[next];
    alignedPlane = null;
    hovered = null;
    change();
  }

  function pointOnView(event, view) {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / view.width * 2 - 1) * view.span[0] + pan[0],
      (1 - (event.clientY - rect.top) / view.height * 2) * view.span[1] + pan[1],
    ];
  }

  function sketchPoint(event) {
    const view = camera();
    if (Math.abs(view.forward[2]) < 0.000001) return null;
    const [x, y] = pointOnView(event, view);
    const origin = center.map((value, axis) => value + x * view.right[axis] + y * view.up[axis]);
    const travel = (sketch.planeZ - origin[2]) / view.forward[2];
    const point = [origin[0] + travel * view.forward[0], origin[1] + travel * view.forward[1]];
    if (bypassSketchSnap(event)) {
      setSnapTarget(null);
      return point;
    }
    return snapPoint(view, point, sketch.planeZ);
  }

  function viewPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  function localPoint(event, entry, exceptId = null, snapping = true, anchor = null) {
    const view = camera();
    const plane = entry.plane;
    const normalDirection = sketchNormal(plane);
    const divisor = dot(view.forward, normalDirection);
    if (Math.abs(divisor) < 1e-7) return null;
    const [x, y] = pointOnView(event, view);
    const near = center.map((value, axis) => value + x * view.right[axis] + y * view.up[axis]);
    const travel = dot(subtract(plane.origin, near), normalDirection) / divisor;
    const relative = subtract(near.map((value, axis) => value + travel * view.forward[axis]), plane.origin);
    const local = [dot(relative, plane.x), dot(relative, plane.y)];
    if (!snapping) return local;
    if (bypassSketchSnap(event)) {
      setSnapTarget(null);
      return local;
    }
    return snapLocalPoint(entry, local, [exceptId], anchor);
  }

  function snapLocalPoint(entry, local, exceptIds, anchor = null) {
    if (!snapEnabled) return local;
    const view = camera(), {plane} = entry;
    const pixel = project(view, worldPoint(plane, local));
    let nearest = SNAP_DISTANCE;
    let target = null;
    function consider(candidate, kind) {
      const world = worldPoint(plane, candidate);
      const projected = project(view, world);
      const distance = Math.hypot(projected[0] - pixel[0], projected[1] - pixel[1]);
      if (distance > nearest || target && distance === nearest) return;
      target = {kind, world, point: candidate};
      nearest = distance;
    }
    const hidden = new Set(entry.hiddenEntityIds ?? []);
    const entities = (entry.entities ?? []).filter((entity) => !exceptIds.includes(entity.id) && !hidden.has(entity.id));
    if (!intersectionsBySketch.has(entry)) intersectionsBySketch.set(entry, collectIntersections(entry.segments));
    for (const {point, entities: sources} of intersectionsBySketch.get(entry)) {
      if ([...sources].every((id) => !exceptIds.includes(id) && !hidden.has(id))) consider(point, 'intersection');
    }
    for (const entity of entities) {
      const isConic = entity.kind === 'circle' || entity.kind === 'ellipse' || OPEN_ARCS.has(entity.kind);
      if (isConic) {
        consider([entity.x, entity.y], 'center');
      }
      if (!isConic) {
        for (const point of sketchOutline(entity)) consider(point, 'endpoint');
      }
      if (entity.kind === 'line') {
        consider([(entity.x1 + entity.x2) / 2, (entity.y1 + entity.y2) / 2], 'midpoint');
      } else if (OPEN_ARCS.has(entity.kind)) {
        for (const point of curveEnds(entity)) consider(point, 'endpoint');
        consider(arcPoint(entity, 0.5), 'midpoint');
      }
    }
    consider([0, 0], 'origin');
    if (!target && anchor) {
      consider([local[0], anchor[1]], 'horizontal');
      consider([anchor[0], local[1]], 'vertical');
    }
    if (!target) {
      for (const entity of entities) {
        const onCurve = closestCurvePoint(entity, local);
        if (onCurve) consider(onCurve, 'curve');
      }
    }
    if (!target) {
      const step = gridStep(view);
      consider(local.map((value) => Math.round(value / step) * step), 'grid');
    }
    setSnapTarget(target);
    return target?.point ?? local;
  }

  function triangleHit(points, view, worldX, worldY) {
    let nearest = -Infinity;
    for (let i = 0; i < points.length; i += 9) {
      const a = points.slice(i, i + 3), b = points.slice(i + 3, i + 6), c = points.slice(i + 6, i + 9);
      const ax = dot(a, view.right) - worldX, bx = dot(b, view.right) - worldX, cx = dot(c, view.right) - worldX;
      if ((ax > 0 && bx > 0 && cx > 0) || (ax < 0 && bx < 0 && cx < 0)) continue;
      const ay = dot(a, view.up) - worldY, by = dot(b, view.up) - worldY, cy = dot(c, view.up) - worldY;
      if ((ay > 0 && by > 0 && cy > 0) || (ay < 0 && by < 0 && cy < 0)) continue;
      const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(area) < 1e-16) continue;
      const u = ((by - cy) * -cx + (cx - bx) * -cy) / area;
      const v = ((cy - ay) * -cx + (ax - cx) * -cy) / area;
      const w = 1 - u - v;
      if (Math.min(u, v, w) < -1e-8) continue;
      nearest = Math.max(nearest, u * dot(a, view.forward) + v * dot(b, view.forward) + w * dot(c, view.forward));
    }
    return nearest;
  }

  function pick(event) {
    const layer = focus === 'domain' ? 'domain' : 'part';
    const shape = shapes[layer];
    if (!shape) return null;
    const view = camera();
    const [x, y] = pointOnView(event, view);
    const worldX = x + dot(center, view.right), worldY = y + dot(center, view.up);
    let nearestDepth = -Infinity;
    let nearestFace = null;
    for (const face of shape.mesh.faces) {
      const depth = triangleHit(face.positions, view, worldX, worldY);
      if (depth > nearestDepth) {
        nearestDepth = depth;
        nearestFace = face;
      }
    }
    if (!nearestFace) return null;
    const point = view.right.map((value, axis) => worldX * value + worldY * view.up[axis] + nearestDepth * view.forward[axis]);
    return {
      id: nearestFace.id, plane_z: nearestFace.plane_z, plane: nearestFace.plane ?? null, layer, depth: nearestDepth,
      point, ref: nearestFace.ref, body_id: nearestFace.body_id, surface: nearestFace.surface,
      fillet_index: nearestFace.fillet_index, fillet_radius: nearestFace.fillet_radius, cylinder: nearestFace.cylinder,
    };
  }

  function faceNormal(face) {
    if (face.plane) return sketchNormal(face.plane);
    if (face.surface?.kind !== 'cylinder') return null;
    const {origin, axis, sense} = face.surface;
    const offset = subtract(face.point, origin);
    const radial = unit(offset.map((value, index) => value - dot(offset, axis) * axis[index]));
    return radial?.map((value) => value * (sense ?? 1)) ?? null;
  }

  function sketchEdgeHit(entry, view, pixel) {
    let best = null;
    const hidden = new Set(entry.hiddenEntityIds ?? []);
    const selected = entry.profiles?.find((profile) => profile.id === workspace.activeRegion)?.entityIds ?? [];
    const channel = entry.editableChannels?.find((item) => item.id === workspace.channelSelection);
    const visible = new Set([...selected, ...(channel?.outlineIds ?? [])]);
    const entities = entry.entities || [];
    const ordered = visible.size ? [...entities].sort((a, b) => Number(visible.has(b.id)) - Number(visible.has(a.id))) : entities;
    for (const entity of ordered) {
      if (hidden.has(entity.id) && !visible.has(entity.id)) continue;
      const local = sketchOutline(entity);
      const outline = local.map((point) => project(view, worldPoint(entry.plane, point)));
      if (entity.kind === 'rectangle' || entity.kind === 'point' || entity.kind === 'line') {
        for (let i = 0; i < outline.length; i++) {
          const distance = Math.hypot(pixel[0] - outline[i][0], pixel[1] - outline[i][1]);
          if (distance <= 8 && (!best || best.corner === null || distance < best.distance)) {
            best = {entity, corner: i, side: null, distance, point: local[i]};
          }
        }
      }
      if (best?.corner != null || outline.length < 2) continue;
      const count = entity.kind === 'line' || OPEN_ARCS.has(entity.kind) ? outline.length - 1 : outline.length;
      for (let i = 0; i < count; i++) {
        const next = (i + 1) % outline.length;
        const {distance, t} = nearestSegment(pixel, outline[i], outline[next]);
        if (distance <= 7 && (!best || distance < best.distance)) {
          const point = local[i].map((value, axis) => value + (local[next][axis] - value) * t);
          best = {entity, corner: null, side: i, distance, point};
        }
      }
    }
    return best;
  }

  function internalOverlap(entry, hit) {
    if (hit.entity.kind === 'point' || !entry.overlapGroups?.length) return undefined;
    const regions = entry.regions ?? [];
    const {plane} = entry;
    const basis = {right: plane.x, up: plane.y, forward: sketchNormal(plane)};
    const outline = sketchOutline(hit.entity);
    const side = hit.side ?? hit.corner;
    const tangent = unit(subtract([...outline[(side + 1) % outline.length], 0], [...outline[side], 0]));
    if (!tangent) return undefined;
    const tolerance = Math.max(camera().span[1] / camera().height, 1e-5);
    const normal = [-tangent[1] * tolerance, tangent[0] * tolerance];
    // Testing on both sides leaves coincident outside edges as ordinary elements.
    const stableInterior = (region) => [-1, 1].every((sign) => {
      const point = worldPoint(plane, hit.point.map((value, axis) => value + sign * normal[axis]));
      return Number.isFinite(triangleHit(region.positions, basis, dot(point, plane.x), dot(point, plane.y)));
    });
    for (const group of entry.overlapGroups) {
      const members = regions.filter((region) => group.includes(region.id));
      const owner = members.find((region) => region.entityIds?.includes(hit.entity.id));
      if (owner && members.some((region) => !region.entityIds?.includes(hit.entity.id) && stableInterior(region))) {
        return owner.id;
      }
    }
    return undefined;
  }

  function partEdgeHit(view, pixel, frontDepth, projecting = false) {
    const mesh = shapes.part?.mesh;
    if (focus === 'domain' || !mesh?.edge_refs) return null;
    const tolerance = view.span[1] * 18 / view.height;
    let best = null;
    for (let index = 0; index < mesh.edges.length; index++) {
      const ref = mesh.edge_refs[index];
      const metadata = mesh.edge_meta?.[index];
      if (!ref || (projecting ? !metadata?.curve : metadata?.fillet_enabled === false)) continue;
      const points = mesh.edges[index];
      let previous = points.slice(0, 3);
      let a = project(view, previous);
      for (let i = 3; i < points.length; i += 3) {
        const next = points.slice(i, i + 3);
        const b = project(view, next);
        const {t, distance} = nearestSegment(pixel, a, b);
        const depth = (1 - t) * dot(previous, view.forward) + t * dot(next, view.forward);
        if (distance <= 7 && depth + tolerance >= frontDepth &&
            (!best || distance < best.distance - 1 || (Math.abs(distance - best.distance) <= 1 && depth > best.depth))) {
          best = {...metadata, ref, points, distance, depth,
            point: previous.map((value, axis) => value + t * (next[axis] - value))};
        }
        a = b;
        previous = next;
      }
    }
    return best;
  }

  function toolTarget(event, entry) {
    const {tool} = workspace, view = camera(), pixel = viewPoint(event);
    const point = localPoint(event, entry, null, false);
    if (!point) return null;
    const target = {tool, sketchId: entry.id, point, at: [event.clientX, event.clientY]};
    if (tool === 'project') {
      const edge = partEdgeHit(view, pixel, pick(event)?.depth ?? -Infinity, true);
      return edge ? {...target, edge} : null;
    }
    if (tool === 'trim' || tool === 'split' || tool === 'round') {
      let nearest = 8;
      let closest = null;
      for (const [segmentIndex, segment] of (entry.segments ?? []).entries()) {
        const {entityId, curve} = segment;
        if (tool === 'round' && curve.kind !== 'line') continue;
        const onCurve = closestCurvePoint(curve, point);
        if (!onCurve) continue;
        const distance = Math.hypot(...subtract(project(view, worldPoint(entry.plane, onCurve)), pixel));
        if (distance < nearest) {
          nearest = distance;
          closest = {...target, entityId, curve, segmentIndex, point: onCurve};
        }
      }
      if (closest || tool === 'trim' || tool === 'split') return closest;
    }
    const boundary = sketchEdgeHit(entry, view, pixel);
    return boundary ? {...target, entityId: boundary.entity.id, curve: boundary.entity} : null;
  }

  function setToolHover(target) {
    gestureHover = target ? {kind: 'work-tool', target} : null;
    if (target) canvas.dataset.sketchToolHover = target.tool;
    else delete canvas.dataset.sketchToolHover;
  }

  function regionHit(event, view, entries, frontDepth) {
    const [x, y] = pointOnView(event, view);
    const worldX = x + dot(center, view.right), worldY = y + dot(center, view.up);
    let depth = frontDepth - 1e-6;
    let hit = null;
    for (const entry of entries) {
      for (const region of entry.regions || []) {
        const at = triangleHit(region.positions, view, worldX, worldY);
        if (at > depth) {
          const used = entry.pulledRegionIds?.some((id) => id === region.id || region.entityIds.includes(id));
          if (used && Math.abs(at - frontDepth) < 1e-6) continue;
          hit = {kind: 'work-pull', entry, region};
          depth = at;
        }
      }
    }
    return hit;
  }

  function profileHit(event, view, entry) {
    const [x, y] = pointOnView(event, view);
    const worldX = x + dot(center, view.right), worldY = y + dot(center, view.up);
    let top = null;
    for (const profile of entry.profiles ?? []) {
      if (!Number.isFinite(triangleHit(profile.positions, view, worldX, worldY))) continue;
      if (profile.id === workspace.activeRegion) return profile;
      top = profile;
    }
    return top;
  }

  let hitIndex = 0, lastHitEvent = null;
  function gestureHit(event, face) {
    const view = camera(), pixel = viewPoint(event), current = activeSketch();
    if (current) {
      const hit = sketchEdgeHit(current, view, pixel);
      if (hit) {
        const channel = channelForOutline(current, [hit.entity.id]);
        if (workspace.tool === 'move') {
          const profiles = (current.profiles ?? []).filter((profile) => profile.entityIds.includes(hit.entity.id));
          const region = profiles.find((profile) => profile.id === workspace.activeRegion) ?? profiles.at(-1);
          if (region) return {kind: 'work-move', entry: current, region, channel: channelForOutline(current, region.entityIds)};
        }
        return {kind: 'work-edit', entry: current, hit, channel, locked: channel && (hit.entity.kind !== 'arc' || workspace.tool === 'move'),
          translate: workspace.tool === 'move' && !channel};
      }
      const region = profileHit(event, view, current);
      return region ? {kind: 'work-move', entry: current, region, channel: channelForOutline(current, region.entityIds)} : null;
    }
    const frontDepth = face?.depth ?? -Infinity;
    const edge = partEdgeHit(view, pixel, frontDepth);
    const choices = [];
    if (edge) choices.push({kind:'work-fillet',edge});
    const pull = regionHit(event, view, workspace.sketches, frontDepth);
    if (pull) choices.push({...pull, body:pull.entry.body_id});
    if (face?.layer === 'part' && face.ref && face.body_id) {
      const normalDirection = faceNormal(face);
      if (normalDirection) {
        if (Number.isInteger(face.fillet_index) && Number.isFinite(face.fillet_radius)) {
          choices.push({kind: 'work-fillet', edge: {ref: face.ref, body_id: face.body_id, point: face.point,
            inward: normalDirection.map((value) => -value), fillet_index: face.fillet_index, radius: face.fillet_radius}});
        } else if (face.surface?.editable !== false) choices.push({kind:'work-face',face,normalDirection,anchor:face.point});
      }
    }
    return choices.length ? {...choices[hitIndex % choices.length], choices:choices.length} : null;
  }

  function dimensionTarget(event) {
    if (sketch || !isSketchSelectionTool(workspace.tool)) return null;
    const current = activeSketch();
    const view = camera();
    const pixel = viewPoint(event);
    const at = [event.clientX, event.clientY];
    const sketchTarget = (entry) => {
      const boundary = sketchEdgeHit(entry, view, pixel);
      if (boundary) {
        const entityId = boundary.entity.id;
        if (workspace.tool === 'select' || channelForOutline(entry, [entityId])) return {kind: 'sketch', sketchId: entry.id, entityId, at};
        return null;
      }
      const region = profileHit(event, view, entry);
      if (channelForOutline(entry, region?.entityIds)) {
        const wall = entry.entities.find((entity) => entity.kind === 'line' && region.entityIds.includes(entity.id));
        return {kind: 'sketch', sketchId: entry.id, entityId: wall?.id ?? region.entityIds[0], at};
      }
      if (workspace.tool === 'select' && region?.entityIds?.length === 1) {
        return {kind: 'sketch', sketchId: entry.id, entityId: region.entityIds[0], at};
      }
      return null;
    };
    if (current) return sketchTarget(current);
    if (workspace.tool !== 'select') return null;
    const face = pick(event);
    if (face?.layer === 'part' && Number.isInteger(face.fillet_index)) return {kind: 'face', face, at};
    const edge = partEdgeHit(view, pixel, face?.depth ?? -Infinity);
    if (edge) return {kind: 'edge', edge, at};
    if (face?.layer === 'part') return {kind: 'face', face, at};
    return null;
  }

  function alignToPlane(plane, viewName = null) {
    const previous = camera();
    alignedPlane = plane;
    const normalDirection = sketchNormal(plane);
    const visibleCenter = center.map((value, axis) => value + pan[0] * previous.right[axis] + pan[1] * previous.up[axis]);
    const distance = dot(subtract(plane.origin, visibleCenter), normalDirection);
    center = visibleCenter.map((value, axis) => value + distance * normalDirection[axis]);
    pan = [0, 0];
    azimuth = Math.atan2(normalDirection[1], normalDirection[0]);
    elevation = Math.asin(clamp(normalDirection[2], -1, 1));
    name = viewName ?? (Math.abs(normalDirection[2] - 1) < 1e-7 ? 'top' : 'free');
    change();
  }

  function viewSketchPlane(plane = activeSketch()?.plane) {
    if (!plane) return false;
    hovered = null;
    setToolHover(null);
    setSnapTarget(null);
    alignToPlane(plane, 'plane');
    return true;
  }

  function vectorDirection(normalDirection) {
    const view = camera();
    return [dot(normalDirection, view.right) * view.width / (2 * view.span[0]),
      -dot(normalDirection, view.up) * view.height / (2 * view.span[1])];
  }

  function tiltPullView(gesture) {
    const {plane} = gesture.entry;
    const anchor = gesture.anchor;
    const previous = project(camera(), anchor);
    const angle = 28 * RAD;
    const normalDirection = sketchNormal(plane);
    alignedPlane = {...plane, y: plane.y.map((value, axis) => value * Math.cos(angle) + normalDirection[axis] * Math.sin(angle))};
    const viewed = camera();
    const next = project(viewed, anchor);
    pan[0] += 2 * viewed.span[0] * (next[0] - previous[0]) / viewed.width;
    pan[1] -= 2 * viewed.span[1] * (next[1] - previous[1]) / viewed.height;
    const forward = viewed.forward;
    azimuth = Math.atan2(forward[1], forward[0]);
    elevation = Math.asin(clamp(forward[2], -1, 1));
    name = 'free';
    change();
  }

  function tiltToShowVector(vector, anchor) {
    const view = camera();
    const toward = dot(vector, view.forward) < 0 ? vector.map((value) => -value) : vector;
    const x = unit(view.right.map((value, axis) => value - dot(view.right, toward) * toward[axis]));
    if (!x) return;
    tiltPullView({entry: {plane: {origin: anchor, x, y: cross(toward, x)}}, anchor});
  }

  function movementAlong(direction, motion) {
    const length2 = direction[0] ** 2 + direction[1] ** 2;
    return length2 > 1e-12 ? (motion[0] * direction[0] + motion[1] * direction[1]) / length2 : 0;
  }

  function snapPullDistance(gesture, distance, direction) {
    if (!snapEnabled || !distance || gesture.mode === 'cut' ||
        (gesture.mode === 'auto' && distance < 0 && shapes.part)) return null;
    const pixelsPerMm = Math.hypot(...direction);
    if (pixelsPerMm < 1e-9) return null;
    const {plane} = gesture.entry;
    if (!gesture.snapDistances) {
      const normal = sketchNormal(plane);
      gesture.snapDistances = (shapes.part?.mesh.faces ?? []).flatMap((face) => {
        if (!face.plane || Math.abs(dot(sketchNormal(face.plane), normal)) < 1 - 1e-7) return [];
        const offset = dot(subtract(face.plane.origin, plane.origin), normal);
        return Math.abs(offset) > 1e-7 ? [{offset, face}] : [];
      });
    }
    let closest = SNAP_DISTANCE;
    let snapped = null;
    for (const candidate of gesture.snapDistances) {
      const delta = Math.abs(candidate.offset - distance) * pixelsPerMm;
      if (delta > closest || Math.sign(candidate.offset) !== Math.sign(distance)) continue;
      if (candidate.overlap === undefined) {
        gesture.footprint ??= footprint(gesture.region.positions, plane);
        candidate.overlap = footprintsOverlap(gesture.footprint, footprint(candidate.face.positions, plane));
      }
      if (candidate.overlap) {
        closest = delta;
        snapped = candidate.offset;
      }
    }
    return snapped;
  }

  function previewOperation(operation) {
    if (!operation && !drag.operation) return;
    if (operation && drag.operation && operation.type === drag.operation.type &&
        operation.radius === drag.operation.radius && operation.distance === drag.operation.distance) return;
    drag.operation = operation;
    if (!operation) setPreview(null);
    onDirectPreview?.(operation);
  }

  function clearDirectPreview(gesture) {
    if (gesture?.operation || previewCount) {
      setPreview(null);
      onDirectPreview?.(null);
    }
  }

  function dragDirection(gesture, vector, anchor, motion) {
    let direction = vectorDirection(vector);
    const view = camera();
    if (!gesture.tilted && Math.hypot(...motion) >= DEPTH_DRAG_THRESHOLD &&
        Math.hypot(...direction) < 0.12 * view.height / (2 * view.span[1])) {
      if (gesture.kind === 'work-pull') tiltPullView(gesture);
      else tiltToShowVector(vector, anchor);
      gesture.tilted = true;
      direction = vectorDirection(vector);
    }
    return direction;
  }

  function beginWorkspaceGesture(event) {
    const entry = activeSketch();
    if (entry && !isSketchSelectionTool(workspace.tool)) {
      if (CURVE_TOOLS.has(workspace.tool)) return {kind: 'work-tool', entry, target: toolTarget(event, entry)};
      const draft = draftGesture(event, entry);
      if (!draft) return null;
      lastDraftPointer = event;
      draftHover = null;
      showDraftValues(event, draft);
      return draft;
    }
    const hit = gestureHit(event, entry ? null : pick(event));
    if (!hit) return null;
    if (hit.kind === 'work-edit' && !hit.translate && !hit.locked) {
      return {...hit, start: localPoint(event, hit.entry, hit.hit.entity.id, false)};
    }
    if (hit.kind === 'work-move' || hit.translate) {
      const start = localPoint(event, entry, null, false);
      const source = hit.hit?.entity ?? entry.entities.find((entity) => hit.region.entityIds.includes(entity.id));
      if (!start || !source) return null;
      const entityIds = hit.channel ? [...hit.channel.centerlineIds, ...hit.channel.outlineIds] : hit.region?.entityIds ?? [source.id];
      return {...hit, start, entityIds, anchor: [source.x ?? source.x1, source.y ?? source.y1], offset: [0, 0]};
    }
    if (hit.kind === 'work-pull') {
      const location = localPoint(event, hit.entry, null, false);
      const mode = workspace.pullMode ?? 'auto';
      return location ? {...hit, mode, anchor: worldPoint(hit.entry.plane, location), snapDistances: null} : null;
    }
    if (hit.kind === 'work-fillet') {
      const actualBounds = shapes.part?.mesh.bounds;
      const bodyCenter = actualBounds?.slice(0, 3).map((value, axis) => (value + actualBounds[axis + 3]) / 2);
      const inward = unit(hit.edge.inward ?? subtract(bodyCenter ?? center, hit.edge.point));
      if (!inward) return null;
      return {...hit, inward};
    }
    return hit;
  }

  function moveWorkspaceGesture(event) {
    const motion = [event.clientX - drag.downX, event.clientY - drag.downY];
    if (drag.kind === 'work-create' || drag.kind === 'work-arc') {
      const draft = draftGesture(event, drag.entry, drag);
      if (!draft) return;
      lastDraftPointer = event;
      drag.entity = draft.entity;
      drag.point = draft.point;
      showDraftValues(event, draft);
    } else if (drag.kind === 'work-tool') {
      drag.target = toolTarget(event, drag.entry);
      setToolHover(drag.target);
    } else if (drag.kind === 'work-move' || drag.translate) {
      const point = localPoint(event, drag.entry, null, false);
      if (!point) return;
      const next = point.map((value, axis) => drag.anchor[axis] + value - drag.start[axis]);
      const bypass = bypassSketchSnap(event);
      const snapped = bypass ? next : snapLocalPoint(drag.entry, next, drag.entityIds);
      if (bypass) setSnapTarget(null);
      drag.offset = snapped.map((value, axis) => value - drag.anchor[axis]);
      if (drag.translate) drag.entity = translatedSketch(drag.hit.entity, drag.offset);
      const [dx, dy] = drag.offset.map((value) => `${value > 0 ? '+' : ''}${METRIC.format(value)}`);
      showCursorValues(event, `이동 ΔX ${dx} · ΔY ${dy} mm`);
    } else if (drag.kind === 'work-edit' && drag.start) {
      const point = localPoint(event, drag.entry, drag.hit.entity.id, !drag.channel);
      if (!point) return;
      drag.entity = resizeSketch(drag.hit, drag.start, point);
      const dimensions = sketchDimensions(drag.entity);
      showCursorValues(event, drag.channel ? '유로 벽 ' + dimensions : dimensions);
    } else if (drag.kind === 'work-pull') {
      const direction = dragDirection(drag, sketchNormal(drag.entry.plane), drag.anchor, motion);
      const distance = clamp(movementAlong(direction, motion), -1_000_000, 1_000_000);
      const snapped = snapPullDistance(drag, distance, direction);
      drag.value = snapped ?? roundMm(distance);
      previewOperation(Math.hypot(...motion) >= DEPTH_DRAG_THRESHOLD && drag.value ?
        {type: 'pull', sketch: drag.entry.id, region: drag.region.id, distance: drag.value, body: drag.body, mode: drag.mode} : null);
      const label = drag.mode === 'cut' || (drag.mode === 'auto' && drag.value < 0 && shapes.part) ? '절삭 '
        : drag.mode === 'join' ? '결합 ' : '돌출 ';
      showCursorValues(event, (snapped === null ? '' : '면 스냅 · ') + label + METRIC.format(Math.abs(drag.value)) + ' mm');
    } else if (drag.kind === 'work-face') {
      const {face, normalDirection, anchor} = drag;
      const direction = dragDirection(drag, normalDirection, anchor, motion);
      let distance = roundMm(clamp(movementAlong(direction, motion), -1_000_000, 1_000_000));
      if (face.surface?.kind === 'cylinder') {
        const {radius: previous, sense = 1} = face.surface;
        const next = roundMm(clamp(previous + distance * sense, 0.001, 1_000_000));
        distance = roundMm((next - previous) * sense);
        showCursorValues(event, '반지름 R ' + METRIC.format(next) + ' mm');
      } else {
        showCursorValues(event, '면 이동 ' + (distance > 0 ? '+' : '') + METRIC.format(distance) + ' mm');
      }
      drag.value = distance;
      previewOperation(Math.hypot(...motion) >= DEPTH_DRAG_THRESHOLD && distance ?
        {type: 'face_edit', body: face.body_id, face: face.ref, distance} : null);
    } else if (drag.kind === 'work-fillet') {
      const {edge, inward} = drag;
      const direction = dragDirection(drag, inward, edge.point, motion);
      const start = edge.radius ?? 0;
      drag.value = roundMm(clamp(start + movementAlong(direction, motion), 0, 1_000_000));
      const index = Number.isInteger(edge.fillet_index) ? edge.fillet_index : undefined;
      previewOperation(Math.hypot(...motion) >= DEPTH_DRAG_THRESHOLD && drag.value !== start &&
        (drag.value > 0 || index !== undefined) ?
        {type: 'fillet', body: edge.body_id, edge: edge.ref, radius: drag.value, index} : null);
      showCursorValues(event, '필렛 R ' + METRIC.format(drag.value) + ' mm');
    }
    schedule();
  }

  function finishWorkspaceGesture(event, gesture) {
    const {kind, entry, region, entity, value, hit} = gesture;
    const motion = Math.hypot(event.clientX - gesture.downX, event.clientY - gesture.downY);
    if (kind === 'work-tool') {
      if (gesture.target && motion < DEPTH_DRAG_THRESHOLD) onSketchToolPick?.(gesture.target);
    } else if (kind === 'work-arc') {
      if (motion >= DEPTH_DRAG_THRESHOLD) return;
      if (workspace.tool === 'tangent-arc' && !tangentStart) {
        tangentStart = tangentReference(entry, event);
      } else if (workspace.tool === 'arc' && arcAnchors.length < 2) {
        if (!arcAnchors.length || Math.hypot(...subtract(gesture.point, arcAnchors[0])) > 1e-7) {
          arcAnchors.push(gesture.point);
        }
      } else if (drawable(entity)) {
        commitDraftEntity(entity);
        return;
      }
      showDraftValues(event, {...gesture, entity: null});
    } else if (kind === 'work-create') {
      if (workspace.tool !== 'point' && !gesture.anchored && motion < DEPTH_DRAG_THRESHOLD) {
        if (workspace.tool === 'line') lineAnchor = gesture.start;
        else shapeAnchor = gesture.start;
      } else if (drawable(entity)) {
        commitDraftEntity(entity);
      }
    } else if (kind === 'work-move') {
      onSketchSelect?.({kind: 'region', sketch: entry.id, region: region.id});
      if (motion >= DEPTH_DRAG_THRESHOLD && gesture.offset.some(Boolean)) {
        onSketchMove?.(entry.id, region.id, ...gesture.offset);
      }
    } else if (motion >= 4) {
      if (kind === 'work-edit' && drawable(entity) && JSON.stringify(entity) !== JSON.stringify(hit.entity)) {
        onSketchEdit?.(entry.id, hit.entity.id, entity);
      } else if (kind === 'work-pull' && value) {
        onSketchPull?.(entry.id, region.id, value, gesture.body, gesture.mode);
      } else if (gesture.operation && (kind === 'work-face' || kind === 'work-fillet')) {
        if (onDirectCommit) onDirectCommit(gesture.operation);
        else if (kind === 'work-fillet' && value > 0) onFillet?.(gesture.edge.ref, value);
      }
    } else if (kind === 'work-edit') {
      const selection = {sketchId: entry.id, entityId: hit.entity.id};
      const overlapRegion = internalOverlap(entry, hit);
      if (overlapRegion) selection.overlapRegion = overlapRegion;
      onSketchSelect?.(selection);
    } else {
      onSketchSelect?.(null);
      onPick?.(pick(event));
    }
  }

  function cancelCanvasGesture() {
    const captured = drag?.id;
    clearDirectPreview(drag);
    drag = null;
    if (captured !== undefined && canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured);
    closePrecision();
    lineAnchor = shapeAnchor = draftHover = lastDraftPointer = tangentStart = null;
    arcAnchors = [];
    setToolHover(null);
    setSnapTarget(null);
    showCursorValues(null);
    canvas.style.cursor = sketch || !isSketchSelectionTool(workspace.tool) ? 'crosshair' : '';
  }

  depthHandle?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !depthTool || depthDrag || drag || activeSketch()) return;
    const pixels = depthPixels(camera());
    const pixelsPerMm = Math.hypot(...pixels);
    if (pixelsPerMm < 1e-9) return;
    event.preventDefault();
    depthDrag = {id: event.pointerId, start: [event.clientX, event.clientY],
      direction: pixels.map((component) => component / pixelsPerMm), pixelsPerMm, height: depthTool.height};
    depthHandle.setPointerCapture(event.pointerId);
  });

  depthHandle?.addEventListener('pointermove', (event) => {
    if (depthDrag?.id === event.pointerId) updateDepth(event);
  });

  depthHandle?.addEventListener('pointerup', (event) => {
    if (depthDrag?.id !== event.pointerId) return;
    if (updateDepth(event)) {
      depthDrag = null;
      showCursorValues(null);
      onDepthCommit?.(depthTool.height);
    } else {
      cancelDepthDrag();
    }
  });

  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    depthHandle?.addEventListener(eventName, (event) => {
      if (depthDrag?.id === event.pointerId) cancelDepthDrag();
    });
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (portCaps.length && event.button === 0) {
      const point = viewPoint(event), view = camera();
      let best = 12, ref = null;
      for (const cap of portCaps) for (const edge of cap.edges) {
        let prev = project(view, edge.slice(0,3));
        for (let i=3;i<edge.length;i+=3) {
          const next = project(view, edge.slice(i,i+3));
          const dx=next[0]-prev[0], dy=next[1]-prev[1];
          const t=clamp(((point[0]-prev[0])*dx+(point[1]-prev[1])*dy)/(dx*dx+dy*dy || 1),0,1);
          const dist=Math.hypot(point[0]-prev[0]-t*dx,point[1]-prev[1]-t*dy);
          if(dist<best){best=dist;ref=cap.ref;}
          prev=next;
        }
      }
      if(ref) onPortPick(ref);
      return;
    }
    if (sectionAxis >= 0 && event.button === 0) return;
    if (drag || depthDrag || (event.button !== 0 && event.button !== 1)) return;
    if (event.button === 1 || inspectMesh) event.preventDefault();
    if (precision) closePrecision();
    const point = sketch && event.button === 0 ? sketchPoint(event) : null;
    const kind = inspectMesh ? (event.shiftKey ? 'pan' : 'orbit') : event.button === 1
      ? (event.shiftKey || sketch || activeSketch() ? 'pan' : 'orbit') : point ? 'sketch' : 'pick';
    const workspaceGesture = !inspectMesh && event.button === 0 && !sketch ? beginWorkspaceGesture(event) : null;
    drag = {kind, id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, start: point, end: point,
      downX: event.clientX, downY: event.clientY, ...workspaceGesture};
    canvas.setPointerCapture(event.pointerId);
    if (kind === 'pan' || kind === 'orbit') canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.distance += Math.hypot(dx, dy);
      if (drag.kind === 'pan') {
        const view = camera();
        pan[0] -= 2 * view.span[0] * dx / view.width;
        pan[1] += 2 * view.span[1] * dy / view.height;
        if (sketch) setSnapTarget(null);
        schedule();
      } else if (drag.kind === 'orbit') {
        alignedPlane = null;
        name = 'free';
        azimuth -= dx * 0.008;
        elevation = clamp(elevation + dy * 0.008, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
        change();
      } else if (drag.kind === 'sketch') {
        drag.end = sketchPoint(event);
        if (drag.end) showCursorValues(event, sketchDimensions(sketchEntity(sketch.profile, drag.start, drag.end)));
        schedule();
      } else if (drag.kind.startsWith('work-')) {
        if (!drag.locked && !['work-create', 'work-arc', 'work-tool'].includes(drag.kind)) canvas.style.cursor = 'grabbing';
        moveWorkspaceGesture(event);
      }
      return;
    }
    if (inspectMesh) return;
    if (sketch) {
      sketchPoint(event);
      return;
    }
    const entry = activeSketch();
    if (entry && !isSketchSelectionTool(workspace.tool)) {
      if (precision) return;
      if (CURVE_TOOLS.has(workspace.tool)) {
        const target = toolTarget(event, entry);
        setToolHover(target);
        canvas.style.cursor = target ? 'pointer' : 'crosshair';
        schedule();
        return;
      }
      lastDraftPointer = event;
      const draft = draftGesture(event, entry);
      if (!draft) return;
      draftHover = drawable(draft.entity) && (draft.anchored || draft.kind === 'work-arc') ? draft : null;
      showDraftValues(event, draft);
      schedule();
      return;
    }
    if (!lastHitEvent || Math.hypot(event.clientX-lastHitEvent.clientX,event.clientY-lastHitEvent.clientY)>2) hitIndex=0;
    lastHitEvent=event;
    const face = entry ? null : pick(event);
    const id = face?.id ?? null;
    const nextGesture = gestureHit(event, face);
    if (hovered !== id || gestureHover || nextGesture) {
      if (nextGesture?.channel || gestureHover?.channel) {
        const hint = nextGesture?.channel && '유로 폭 ' + METRIC.format(nextGesture.channel.width) + ' mm · 두 번 클릭해 편집';
        showCursorValues(event, hint);
      } else if (!inspectMesh && !portCaps.length) {
        const labels = {'work-face':'파트 면 · 크기 변경','work-fillet':'솔리드 모서리 · 필렛','work-move':'스케치 영역 · 이동','work-edit':'스케치 모서리 · 치수 변경','work-pull':'스케치 영역 · 돌출 또는 절삭'};
        const label = labels[nextGesture?.kind] || (face?'파트 면':'');
        showCursorValues(event,sectionAxis>=0 ? '단면 검사 · 편집하려면 단면 검사 해제' : label + (nextGesture?.choices>1?' · N 다음 후보':''));
      }
      gestureHover = nextGesture;
      hovered = id;
      canvas.style.cursor = nextGesture && !nextGesture.locked ? 'grab' : nextGesture || id !== null ? 'pointer' : '';
      schedule();
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (drag?.id !== event.pointerId) return;
    if (drag.kind.startsWith('work-')) {
      if (drag.kind !== 'work-edit' || drag.start) moveWorkspaceGesture(event);
      const current = drag;
      clearDirectPreview(current);
      drag = null;
      canvas.style.cursor = isSketchSelectionTool(workspace.tool) ? '' : 'crosshair';
      setSnapTarget(null);
      showCursorValues(null);
      finishWorkspaceGesture(event, current);
      schedule();
      return;
    }
    const {kind, start, distance} = drag;
    drag = null;
    showCursorValues(null);
    canvas.style.cursor = sketch ? 'crosshair' : '';
    if (kind === 'pick' && distance < 4) {
      onSketchSelect?.(null);
      if (!activeSketch()) onPick?.(pick(event));
    } else if (kind === 'sketch' && distance >= 4) {
      const end = sketchPoint(event);
      if (!end) return;
      if (sketch.profile === 'circle') {
        const radius = roundMm(Math.hypot(end[0] - start[0], end[1] - start[1]));
        if (radius > 0) onSketch?.({x: roundMm(start[0]), y: roundMm(start[1]), radius});
      } else {
        const width = roundMm(Math.abs(end[0] - start[0]));
        const length = roundMm(Math.abs(end[1] - start[1]));
        if (width > 0 && length > 0) onSketch?.({x: roundMm(Math.min(start[0], end[0])),
          y: roundMm(Math.min(start[1], end[1])), width, length});
      }
    }
    schedule();
  });

  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(eventName, (event) => {
      if (drag?.id === event.pointerId) cancelCanvasGesture();
    });
  }
  canvas.addEventListener('dblclick', (event) => {
    if (inspectMesh || sectionAxis >= 0) return;
    const target = dimensionTarget(event);
    if (target) onDimensionPick?.(target);
  });
  window.addEventListener('keydown', (event) => {
    if (inspectMesh) return;
    if (event.key === 'Escape' && (drag?.kind.startsWith('work-') || lineAnchor || shapeAnchor ||
      arcAnchors.length || tangentStart)) cancelCanvasGesture();
    if (event.defaultPrevented || event.isComposing ||
      event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea, [contenteditable]')) return;
    if (event.key === 'Shift' && (activeSketch() || sketch)) setSnapTarget(null);
    if (event.key.toLowerCase()==='n' && !event.ctrlKey && !event.altKey && !event.metaKey && !drag && !activeSketch() && lastHitEvent && gestureHover?.choices>1) {
      hitIndex++;
      gestureHover=gestureHit(lastHitEvent,pick(lastHitEvent));
      if (gestureHover) {
        const labels={'work-face':'면','work-fillet':'필렛 모서리','work-pull':'스케치 영역'};
        showCursorValues(lastHitEvent,labels[gestureHover.kind]+' · 후보 '+(hitIndex%gestureHover.choices+1)+'/'+gestureHover.choices);
      }
      schedule(); event.preventDefault(); return;
    }
    if (nudgePrecision(event)) {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.key === ' ' || /^[0-9]$/.test(event.key)) && openPrecision(event)) event.preventDefault();
  });

  canvas.addEventListener('pointerleave', () => {
    lastHitEvent=null; hitIndex=0;
    if (!drag && snapTarget) setSnapTarget(null);
    if (!drag) {
      draftHover = null;
      showCursorValues(null);
    }
    hovered = null;
    setToolHover(null);
    schedule();
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const before = camera();
    const anchor = pointOnView(event, before);
    const previous = scale;
    const delta = event.deltaY * [1, 16, before.height][event.deltaMode];
    scale = clamp(scale * Math.exp(clamp(delta, -600, 600) * 0.0016), fittedScale / 200, fittedScale * 200);
    pan = pan.map((value, axis) => anchor[axis] - (anchor[axis] - value) * scale / previous);
    if (sketch) sketchPoint(event);
    else if (activeSketch() && !isSketchSelectionTool(workspace.tool) && !CURVE_TOOLS.has(workspace.tool)) {
      const draft = draftGesture(event, activeSketch());
      if (draft && draftHover) draftHover = draft;
    }
    change();
  }, {passive: false});

  new ResizeObserver(schedule).observe(canvas);
  schedule();

  return {
    fit, goToOrigin, setView, setPreview, viewSketchPlane, setSection,
    setPortPicker(caps, marked, pick) {portCaps = caps; markedPorts = marked; onPortPick = pick; schedule();},
    setModel(model) {
      hovered = null;
      const nextWireframe = inspectMesh ? model?.wireframe ?? null : null;
      if (nextWireframe !== wireframe) {
        wireframe = nextWireframe;
        wireframeCount = wireframe ? wireframe.edges.length * 2 : 0;
        if (wireframeCount) {
          gl.bindBuffer(gl.ARRAY_BUFFER, wireframeBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wireframe.edges.flat()), gl.STATIC_DRAW);
        }
      }
      for (const layer of ['part', 'domain']) {
        if (shapes[layer]) {
          gl.deleteBuffer(shapes[layer].faces);
          gl.deleteBuffer(shapes[layer].edges);
        }
        shapes[layer] = uploadMesh(gl, model?.[layer]);
      }
      if (!shapes[focus] && focus !== 'both') focus = shapes.part ? 'part' : shapes.domain ? 'domain' : 'part';
      if (!hasFitModel && visibleBounds()) {
        hasFitModel = true;
        fit();
      } else {
        const modelBounds = Object.values(shapes).filter(Boolean).map((shape) => shape.mesh.bounds);
        if (wireframe) modelBounds.push(wireframe.bounds);
        for (const bounds of modelBounds) {
          radius = Math.max(radius, Math.hypot(...center.map((value, axis) =>
            Math.max(Math.abs(value - bounds[axis]), Math.abs(value - bounds[axis + 3])))));
        }
        schedule();
      }
    },
    setSelection(faceId) {
      selection = faceId;
      schedule();
    },
    setFaceHighlights(highlights) {
      faceHighlights = highlights;
      schedule();
    },
    setBodySelection(bodyId) {
      bodySelection = bodyId;
      schedule();
    },
    setSketch(next) {
      sketch = next;
      const captured = drag?.id;
      drag = null;
      if (captured !== undefined && canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured);
      hovered = null;
      setSnapTarget(null);
      canvas.style.cursor = sketch ? 'crosshair' : '';
      if (sketch) setView('top');
      else change();
    },
    setSketchWorkspace(next) {
      const previous = workspace;
      const previousPlane = activeSketch()?.plane;
      workspace = next;
      if (gestureHover?.channel) showCursorValues(null);
      setToolHover(null);
      const current = activeSketch();
      const planeChanged = current && previousPlane && ['origin', 'x', 'y'].some((key) =>
        current.plane[key].some((value, axis) => value !== previousPlane[key][axis]));
      const sketchChanged = previous.activeId !== next.activeId || planeChanged;
      if (sketchChanged || previous.tool !== next.tool) cancelCanvasGesture();
      if (current && sketchChanged) {
        alignToPlane(current.plane);
      }
      schedule();
    },
    setDepthTool(next) {
      cancelDepthDrag();
      depthTool = next;
      if (depthTool && Math.abs(camera().up[2]) < 0.12) setView('iso');
      if (depthHandle && depthTool) {
        const label = depthTool.type === 'cut' ? '절삭 깊이 드래그' : '돌출 높이 드래그';
        depthHandle.setAttribute('aria-label', label);
      }
      schedule();
    },
    setSnap(enabled) {
      snapEnabled = Boolean(enabled);
      setSnapTarget(null);
    },
    setFocus(layer) {
      if (layer !== 'both' && !Object.hasOwn(shapes, layer)) return;
      focus = layer;
      hovered = null;
      schedule();
    },
  };
}

// Planar sketch edits operate in the active plane's millimetre coordinates.
const TAU = 2 * Math.PI;
const tolerance = 1e-7;
const angleTolerance = 1e-8;
const minimumLength = 0.0001;

const add = ([ax, ay], [bx, by]) => [ax + bx, ay + by];
const subtract = ([ax, ay], [bx, by]) => [ax - bx, ay - by];
const scale = ([x, y], amount) => [x * amount, y * amount];
const dot = ([ax, ay], [bx, by]) => ax * bx + ay * by;
const cross = ([ax, ay], [bx, by]) => ax * by - ay * bx;
const magnitude = ([x, y]) => Math.hypot(x, y);
const unit = (vector) => scale(vector, 1 / magnitude(vector));
const left = ([x, y]) => [-y, x];
const close = (a, b) => magnitude(subtract(a, b)) <= tolerance;
const moduloTurn = (angle) => (angle % TAU + TAU) % TAU;
const isCurve = (entity) => entity.kind === 'line' || entity.kind === 'arc';

function arcPoint(arc, end = false) {
  const angle = arc.startAngle + (end ? arc.sweep : 0);
  return [arc.x + arc.radius * Math.cos(angle), arc.y + arc.radius * Math.sin(angle)];
}

function endpoint(curve, end = false) {
  if (curve.kind === 'arc') return arcPoint(curve, end);
  return end ? [curve.x2, curve.y2] : [curve.x1, curve.y1];
}

function moveLineEnd(line, point, end = false) {
  const [x, y] = point;
  return end ? {...line, x2: x, y2: y} : {...line, x1: x, y1: y};
}

function lineBetween([x1, y1], [x2, y2]) {
  return {kind: 'line', x1, y1, x2, y2};
}

function reverse(curve) {
  if (curve.kind === 'arc') {
    return {...curve, startAngle: moduloTurn(curve.startAngle + curve.sweep), sweep: -curve.sweep};
  }
  return {...curve, ...lineBetween(endpoint(curve, true), endpoint(curve))};
}

function tangent(curve, end = false) {
  if (curve.kind === 'line') return unit(subtract(endpoint(curve, true), endpoint(curve)));
  const angle = curve.startAngle + (end ? curve.sweep : 0);
  return scale([-Math.sin(angle), Math.cos(angle)], Math.sign(curve.sweep));
}

const opposite = (a, b) => dot(a, b) < 0 && Math.abs(cross(a, b)) <= angleTolerance;
const outgoing = (curve, end) => scale(tangent(curve, end), end ? -1 : 1);

function placeCurve(curve, end, point, direction = null) {
  const from = endpoint(curve, end);
  const previous = outgoing(curve, end);
  const angle = direction ? Math.atan2(cross(previous, direction), dot(previous, direction)) : 0;
  const c = Math.cos(angle), s = Math.sin(angle);
  const transform = (value) => {
    const [x, y] = subtract(value, from);
    return add(point, [x * c - y * s, x * s + y * c]);
  };
  if (curve.kind === 'line') {
    return {...curve, ...lineBetween(transform(endpoint(curve)), transform(endpoint(curve, true)))};
  }
  const [x, y] = transform([curve.x, curve.y]);
  return {...curve, x, y, startAngle: moduloTurn(curve.startAngle + angle)};
}

function validateEditedCurve(curve) {
  if (curve.kind === 'line') {
    const length = magnitude(subtract(endpoint(curve, true), endpoint(curve)));
    if (!Number.isFinite(length) || length < minimumLength) {
      throw new Error('연결된 선의 길이가 0.0001 mm보다 작아집니다.');
    }
  } else if (curve.kind === 'arc' && (![curve.x, curve.y, curve.radius, curve.startAngle, curve.sweep].every(Number.isFinite) ||
      curve.radius < minimumLength || Math.abs(curve.sweep) >= TAU ||
      Math.abs(curve.sweep) * curve.radius < minimumLength)) {
    throw new Error('연결을 유지하려면 0.0001 mm 이상의 반지름과 유효한 원호 각도가 필요합니다.');
  }
}

export function editConnectedSketchCurve(entities, entityId, updatedCurve) {
  const source = entities.find((curve) => curve.id === entityId);
  if (!source) throw new Error('수정할 스케치 요소를 다시 선택하세요.');
  const edited = {...source, ...updatedCurve, id: entityId};
  if (!isCurve(source) || edited.kind !== source.kind) {
    return entities.map((curve) => curve === source ? edited : curve);
  }
  validateEditedCurve(edited);
  const vertices = [];
  const joined = new Map();
  for (const curve of entities) {
    if (!isCurve(curve) || Boolean(curve.construction) !== Boolean(source.construction)) continue;
    joined.set(curve.id, [false, true].map((end) => {
      const point = endpoint(curve, end);
      let vertex = vertices.find((candidate) => close(candidate.point, point));
      if (!vertex) {
        vertex = {point, connections: []};
        vertices.push(vertex);
      }
      vertex.connections.push({curve, end});
      return vertex;
    }));
  }

  const conflict = () => new Error('현재 치수로는 연결된 선과 원호의 끝점·접선을 함께 유지할 수 없습니다.');
  const updated = new Map([[entityId, edited]]);
  const locations = new Map();
  const queue = [source];
  while (queue.length) {
    const original = queue.shift();
    const next = updated.get(original.id);
    for (const [index, vertex] of joined.get(original.id).entries()) {
      const end = Boolean(index);
      const point = endpoint(next, end);
      const prior = locations.get(vertex);
      if (prior && !close(prior, point)) throw conflict();
      locations.set(vertex, point);
      const direction = outgoing(next, end);
      for (const neighbor of vertex.connections) {
        const {curve, end: otherEnd} = neighbor;
        if (curve === original) continue;
        const smooth = opposite(outgoing(original, end), outgoing(curve, otherEnd));
        const align = smooth && (original !== source || original.kind === 'arc' || curve.kind === 'arc');
        const placed = updated.get(curve.id);
        if (placed) {
          if (!close(endpoint(placed, otherEnd), point) ||
              (align && !opposite(direction, outgoing(placed, otherEnd)))) throw conflict();
          continue;
        }
        const endpointMoved = !close(endpoint(curve, otherEnd), point);
        const directionMoved = align && !opposite(direction, outgoing(curve, otherEnd));
        if ((align && (endpointMoved || directionMoved)) || (curve.kind === 'arc' && endpointMoved)) {
          updated.set(curve.id, placeCurve(curve, otherEnd, point, align ? scale(direction, -1) : null));
          queue.push(curve);
        }
      }
    }
  }

  for (const curve of entities) {
    if (curve.kind !== 'line' || updated.has(curve.id) || !joined.has(curve.id)) continue;
    const [first, last] = joined.get(curve.id).map((vertex) => locations.get(vertex));
    if (first || last) {
      updated.set(curve.id, {...curve, ...lineBetween(first ?? endpoint(curve), last ?? endpoint(curve, true))});
    }
  }
  for (const curve of updated.values()) validateEditedCurve(curve);
  for (const {connections} of vertices) {
    for (const [index, a] of connections.entries()) {
      for (const b of connections.slice(index + 1)) {
        if (a.curve.kind !== 'arc' && b.curve.kind !== 'arc') continue;
        if (!opposite(outgoing(a.curve, a.end), outgoing(b.curve, b.end))) continue;
        const first = updated.get(a.curve.id) ?? a.curve;
        const second = updated.get(b.curve.id) ?? b.curve;
        if (!opposite(outgoing(first, a.end), outgoing(second, b.end))) throw conflict();
      }
    }
  }
  return entities.map((curve) => updated.get(curve.id) ?? curve);
}

function lineIntersection(p, pDirection, q, qDirection) {
  const determinant = cross(pDirection, qDirection);
  if (Math.abs(determinant) <= angleTolerance) return null;
  return add(p, scale(pDirection, cross(subtract(q, p), qDirection) / determinant));
}

function cornerBranch(line, intersection, pick) {
  const direction = tangent(line);
  const start = dot(subtract(endpoint(line), intersection), direction);
  const end = dot(subtract(endpoint(line, true), intersection), direction);
  const along = pick ? dot(subtract(pick, intersection), direction) : 0;
  const retainEnd = start >= -tolerance || (end > tolerance &&
    (along > tolerance || (along >= -tolerance && end >= -start)));
  return retainEnd
    ? {direction, length: end, changeEnd: false}
    : {direction: scale(direction, -1), length: -start, changeEnd: true};
}

export function roundSketchCorner(first, second, radius, arcId, firstPick = null, secondPick = null) {
  if (first.kind !== 'line' || second.kind !== 'line' || first.id === second.id) {
    throw new Error('코너를 만들 서로 다른 직선 두 개를 선택하세요.');
  }
  if (Boolean(first.construction) !== Boolean(second.construction)) {
    throw new Error('일반선끼리 또는 보조선끼리 코너를 선택하세요.');
  }
  if (!Number.isFinite(radius) || radius < minimumLength) {
    throw new Error('필렛 반지름은 0.0001 mm 이상이어야 합니다.');
  }
  const intersection = lineIntersection(endpoint(first), tangent(first), endpoint(second), tangent(second));
  if (!intersection) throw new Error('평행한 두 직선에는 코너를 만들 수 없습니다.');
  const a = cornerBranch(first, intersection, firstPick);
  const b = cornerBranch(second, intersection, secondPick);
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot(a.direction, b.direction)))) / 2;
  const run = radius / Math.tan(halfAngle);
  if (run <= tolerance || run + minimumLength > Math.min(a.length, b.length)) {
    throw new Error('필렛이 선택한 선의 끝을 넘어갑니다. 반지름을 줄이세요.');
  }
  const firstTangent = add(intersection, scale(a.direction, run));
  const secondTangent = add(intersection, scale(b.direction, run));
  const center = add(intersection, scale(unit(add(a.direction, b.direction)), radius / Math.sin(halfAngle)));
  const [u, v] = subtract(firstTangent, center);
  const arc = {
    kind: 'arc', id: arcId, x: center[0], y: center[1], radius,
    startAngle: moduloTurn(Math.atan2(v, u)),
    sweep: -Math.sign(cross(a.direction, b.direction)) * (Math.PI - 2 * halfAngle),
  };
  if (first.construction) arc.construction = true;
  return [moveLineEnd(first, firstTangent, a.changeEnd), moveLineEnd(second, secondTangent, b.changeEnd), arc];
}

function arcProgress(arc, point) {
  const angle = conicAngle(arc, point);
  return moduloTurn(Math.sign(arc.sweep) * (angle - arc.startAngle));
}

function conicAngle(curve, [x, y]) {
  return curve.rx && curve.ry
    ? Math.atan2((y - curve.y) / curve.ry, (x - curve.x) / curve.rx)
    : Math.atan2(y - curve.y, x - curve.x);
}

function curveLength(curve, start, sweep) {
  if (curve.kind === 'arc') return curve.radius * Math.abs(sweep);
  const speed = (angle) => Math.hypot(curve.rx * Math.sin(angle), curve.ry * Math.cos(angle));
  return Math.abs(sweep) * (speed(start) + 4 * speed(start + sweep / 2) + speed(start + sweep)) / 6;
}

export function splitSketchCurve(curve, point, secondId) {
  if (curve.kind === 'circle' || curve.kind === 'ellipse') {
    if (close(point, [curve.x, curve.y])) throw new Error('닫힌 곡선 둘레의 분할점을 선택하세요.');
    const startAngle = moduloTurn(conicAngle(curve, point));
    const kind = curve.kind === 'circle' ? 'arc' : 'ellipseArc';
    const half = {...curve, kind, startAngle, sweep: Math.PI};
    return [half, {...half, id: secondId, startAngle: moduloTurn(startAngle + Math.PI)}];
  }
  if (curve.kind === 'line') {
    const start = endpoint(curve);
    const direction = tangent(curve);
    const distance = dot(subtract(point, start), direction);
    const length = magnitude(subtract(endpoint(curve, true), start));
    if (distance >= minimumLength && length - distance >= minimumLength) {
      const at = add(start, scale(direction, distance));
      return [moveLineEnd(curve, at, true), {...moveLineEnd(curve, at), id: secondId}];
    }
  } else if (curve.kind === 'arc' || curve.kind === 'ellipseArc') {
    const sweep = Math.sign(curve.sweep) * arcProgress(curve, point);
    const end = curve.startAngle + sweep;
    const remaining = curve.sweep - sweep;
    if (Math.sign(remaining) === Math.sign(curve.sweep) &&
      curveLength(curve, curve.startAngle, sweep) >= minimumLength &&
      curveLength(curve, end, remaining) >= minimumLength) {
      return [{...curve, sweep}, {...curve, id: secondId, startAngle: moduloTurn(end), sweep: remaining}];
    }
  } else {
    throw new Error('직선, 원, 타원 또는 호를 선택하세요.');
  }
  throw new Error('곡선의 양 끝점에서 떨어진 곳을 선택하세요.');
}

export function trimSketchSegment(segments, entityId, segmentIndex, makeId, originalEntity = null) {
  if (segments[segmentIndex]?.entityId !== entityId) {
    throw new Error('트림할 교차 구간을 다시 선택하세요.');
  }
  let first = true;
  return segments.flatMap(({entityId: owner, curve}, index) => {
    if (owner !== entityId || index === segmentIndex) return [];
    const replacement = {...curve, id: first ? entityId : makeId()};
    if (originalEntity?.construction) replacement.construction = true;
    first = false;
    return [replacement];
  });
}

function connectedCenterline(entities, seedId) {
  const vertices = [];
  function findVertex(point) {
    const match = vertices.find((vertex) => close(vertex.point, point));
    if (match) return match;
    const vertex = {point, edges: []};
    vertices.push(vertex);
    return vertex;
  }
  const edges = entities.filter(isCurve).map((curve) => {
    const start = findVertex(endpoint(curve));
    const end = findVertex(endpoint(curve, true));
    const edge = {curve, start, end};
    start.edges.push(edge);
    end.edges.push(edge);
    return edge;
  });
  const seed = seedId == null ? edges[0] : edges.find(({curve}) => curve.id === seedId);
  if (!seed) throw new Error('채널 중심선의 직선 또는 원호를 선택하세요.');
  const selected = new Set([seed]);
  const queue = [seed.start, seed.end];
  const componentVertices = new Set(queue);
  while (queue.length) {
    for (const edge of queue.pop().edges) {
      if (selected.has(edge)) continue;
      selected.add(edge);
      for (const vertex of [edge.start, edge.end]) {
        if (componentVertices.has(vertex)) continue;
        componentVertices.add(vertex);
        queue.push(vertex);
      }
    }
  }
  if (seedId == null && selected.size !== edges.length) {
    throw new Error('하나로 이어진 중심선의 직선 또는 원호를 선택하세요.');
  }
  const terminals = [...componentVertices].filter(({edges}) => edges.length === 1);
  if (terminals.length !== 2 || [...componentVertices].some(({edges}) => edges.length > 2)) {
    throw new Error('분기 없이 두 끝점이 열린 하나의 중심선이 필요합니다.');
  }

  let vertex = terminals[0];
  let previous = null;
  const chain = [];
  while (chain.length < selected.size) {
    const edge = vertex.edges.find((item) => item !== previous);
    const forward = edge.start === vertex;
    chain.push(forward ? edge.curve : reverse(edge.curve));
    vertex = forward ? edge.end : edge.start;
    previous = edge;
  }
  return {chain, source: edges.filter((edge) => selected.has(edge)).map(({curve}) => curve)};
}

function offsetCurve(curve, distance) {
  if (curve.kind === 'line') {
    const shift = scale(left(tangent(curve)), distance);
    return lineBetween(add(endpoint(curve), shift), add(endpoint(curve, true), shift));
  }
  const radius = curve.radius - Math.sign(curve.sweep) * distance;
  if (radius < minimumLength) throw new Error('폭이 너무 커서 원호 굽힘의 안쪽 반지름이 사라집니다.');
  const {x, y, startAngle, sweep} = curve;
  return {kind: 'arc', x, y, radius, startAngle, sweep};
}

function channelSide(chain, distance) {
  const offsets = chain.map((curve) => offsetCurve(curve, distance));
  for (let index = 1; index < offsets.length; index++) {
    const a = offsets[index - 1];
    const b = offsets[index];
    const d1 = tangent(chain[index - 1], true);
    const d2 = tangent(chain[index]);
    const end = endpoint(a, true);
    const start = endpoint(b);
    if (close(end, start) && dot(d1, d2) > 1 - angleTolerance) continue;
    if (a.kind !== 'line' || b.kind !== 'line') {
      throw new Error('원호와 연결되는 중심선의 방향은 접점에서 일치해야 합니다.');
    }
    const joint = lineIntersection(end, d1, start, d2);
    if (!joint || magnitude(subtract(joint, endpoint(chain[index]))) > 8 * Math.abs(distance)) {
      throw new Error('중심선의 방향 전환이 너무 급합니다. 코너를 둥글게 하세요.');
    }
    offsets[index - 1] = moveLineEnd(a, joint, true);
    offsets[index] = moveLineEnd(b, joint);
  }
  if (offsets.some((curve, index) => curve.kind === 'line' &&
    dot(subtract(endpoint(curve, true), endpoint(curve)), tangent(chain[index])) < minimumLength)) {
    throw new Error('폭이 너무 커서 중심선의 짧은 코너가 겹칩니다.');
  }
  return offsets;
}

function pointOnArc(arc, point) {
  const epsilon = tolerance / arc.radius;
  const angle = arcProgress(arc, point);
  return angle <= Math.abs(arc.sweep) + epsilon || angle >= TAU - epsilon;
}

function lineContacts(a, b) {
  const p = endpoint(a), q = endpoint(b);
  const u = tangent(a), v = tangent(b);
  const length = magnitude(subtract(endpoint(a, true), p));
  const otherLength = magnitude(subtract(endpoint(b, true), q));
  const intersect = lineIntersection(p, u, q, v);
  if (intersect) {
    const first = dot(subtract(intersect, p), u);
    const second = dot(subtract(intersect, q), v);
    return first >= -tolerance && first <= length + tolerance &&
      second >= -tolerance && second <= otherLength + tolerance ? [intersect] : [];
  }
  if (Math.abs(cross(subtract(q, p), u)) > tolerance) return [];
  const first = dot(subtract(q, p), u);
  const second = dot(subtract(endpoint(b, true), p), u);
  const lo = Math.max(0, Math.min(first, second));
  const hi = Math.min(length, Math.max(first, second));
  return lo <= hi + tolerance ? [add(p, scale(u, lo)), add(p, scale(u, hi))] : [];
}

function lineArcContacts(line, arc) {
  const point = endpoint(line);
  const direction = tangent(line);
  const length = magnitude(subtract(endpoint(line, true), point));
  const relative = subtract([arc.x, arc.y], point);
  const gap = Math.abs(cross(relative, direction));
  if (gap > arc.radius + tolerance) return [];
  const half = Math.sqrt(Math.max(0, (arc.radius - gap) * (arc.radius + gap)));
  const along = dot(relative, direction);
  return [along - half, along + half]
    .filter((value) => value >= -tolerance && value <= length + tolerance)
    .map((value) => add(point, scale(direction, value)))
    .filter((point) => pointOnArc(arc, point));
}

function arcContacts(a, b) {
  const center = [a.x, a.y];
  const direction = subtract([b.x, b.y], center);
  const distance = magnitude(direction);
  if (distance <= tolerance) {
    if (Math.abs(a.radius - b.radius) > tolerance) return [];
    const samples = (arc) => [endpoint(arc), endpoint(arc, true), endpoint({...arc, sweep: arc.sweep / 2}, true)];
    return [...samples(a).filter((point) => pointOnArc(b, point)),
      ...samples(b).filter((point) => pointOnArc(a, point))];
  }
  if (distance > a.radius + b.radius + tolerance ||
    distance < Math.abs(a.radius - b.radius) - tolerance) return [];
  const axis = scale(direction, 1 / distance);
  const along = (distance * distance + (a.radius - b.radius) * (a.radius + b.radius)) / (2 * distance);
  const half = Math.sqrt(Math.max(0, (a.radius - along) * (a.radius + along)));
  const base = add(center, scale(axis, along));
  const lateral = scale(left(axis), half);
  return [add(base, lateral), subtract(base, lateral)]
    .filter((point) => pointOnArc(a, point) && pointOnArc(b, point));
}

function outlineContacts(a, b) {
  if (a.kind === 'line') return b.kind === 'line' ? lineContacts(a, b) : lineArcContacts(a, b);
  return b.kind === 'line' ? lineArcContacts(b, a) : arcContacts(a, b);
}

function validateChannelOutline(outline) {
  for (let index = 0; index < outline.length; index++) {
    for (let next = index + 1; next < outline.length; next++) {
      const shared = next === index + 1 ? endpoint(outline[index], true) :
        index === 0 && next === outline.length - 1 ? endpoint(outline[index]) : null;
      const contacts = outlineContacts(outline[index], outline[next]);
      if (contacts.some((point) => !shared || !close(point, shared))) {
        throw new Error('이 폭에서는 채널 외곽선이 서로 교차합니다.');
      }
    }
  }
}

export function buildSketchChannel(entities, width, makeId, seedId = null) {
  if (!Number.isFinite(width) || width < minimumLength) throw new Error('채널 폭은 0.0001 mm 이상이어야 합니다.');
  const {chain, source} = connectedCenterline(entities, seedId);
  const leftSide = channelSide(chain, width / 2);
  const rightSide = channelSide(chain, -width / 2).reverse().map(reverse);
  const endCap = lineBetween(endpoint(leftSide.at(-1), true), endpoint(rightSide[0]));
  const startCap = lineBetween(endpoint(rightSide.at(-1), true), endpoint(leftSide[0]));
  const outline = [...leftSide, endCap, ...rightSide, startCap];
  validateChannelOutline(outline);
  return {
    centerline: source.map((curve) => ({...curve, construction: true})),
    outline: outline.map((curve, index) => ({...curve, id: makeId(index)})),
    outlineSources: [...chain.map((curve) => curve.id), null, ...chain.map((curve) => curve.id).reverse(), null],
  };
}

function sameGeneratedCurve(first, second) {
  const precision = 1e-9;
  const samePoint = (a, b) => magnitude(subtract(a, b)) <= precision;
  if (first.kind !== second.kind || !samePoint(endpoint(first), endpoint(second)) ||
      !samePoint(endpoint(first, true), endpoint(second, true))) return false;
  if (first.kind === 'line') return true;
  return samePoint([first.x, first.y], [second.x, second.y]) &&
    Math.abs(first.radius - second.radius) <= precision &&
    Math.abs(first.sweep - second.sweep) <= precision;
}

export function recoverSketchChannels(entities) {
  const possible = [];
  for (const [first, curve] of entities.entries()) {
    if (!curve.construction || !isCurve(curve)) continue;
    let end = first + 1;
    while (entities[end]?.construction && isCurve(entities[end])) end++;
    const count = end - first;
    const centerline = entities.slice(first, end);
    const last = end + 2 * count + 2;
    const outline = entities.slice(end, last);
    if (outline.length !== 2 * count + 2 ||
        outline.some((item) => item.construction || !isCurve(item))) continue;
    const cap = outline[count];
    if (cap.kind !== 'line' || outline.at(-1).kind !== 'line') continue;
    const width = magnitude(subtract(endpoint(cap, true), endpoint(cap)));
    const otherCap = outline.at(-1);
    const otherWidth = magnitude(subtract(endpoint(otherCap, true), endpoint(otherCap)));
    if (!Number.isFinite(width) || width < minimumLength || Math.abs(width - otherWidth) > 1e-9) continue;
    const outlineIds = outline.map((item) => item.id);
    const centerlineIds = centerline.map((item) => item.id);
    if (new Set([...outlineIds, ...centerlineIds]).size !== outlineIds.length + centerlineIds.length) continue;
    let match = null;
    for (const seedId of centerlineIds) {
      let generated;
      try {
        generated = buildSketchChannel(centerline, width, (index) => outlineIds[index], seedId);
      } catch {
        continue;
      }
      if (generated.centerline.length !== count ||
          !generated.outline.every((item, index) => sameGeneratedCurve(item, outline[index]))) continue;
      if (!match) match = {id: `channel-legacy-${seedId}`, width, seedId, centerlineIds, outlineIds,
        outlineSources: generated.outlineSources};
      else if (generated.outlineSources.some((id, index) => id !== match.outlineSources[index])) {
        match = null;
        break;
      }
    }
    if (match) possible.push({first, last, match});
  }
  return possible.filter((candidate) => !possible.some((other) =>
    candidate !== other && candidate.first < other.last && candidate.last > other.first))
    .map(({match}) => match);
}

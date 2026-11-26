import { createViewport } from '/cad-view.js';
import {
  buildSketchChannel, editConnectedSketchCurve, recoverSketchChannels, roundSketchCorner, splitSketchCurve, trimSketchSegment,
} from '/cad-sketch-tools.js';

const byId = (id) => document.getElementById(id);
const emptyDocument = () => ({version: 1, operations: [], domainCut: null});
const emptyModel = () => ({part: null, domain: null});
const autosaveKey = 'openfoam-cad-project-v1';
const historyLimit = 30;
const stepSizeLimit = 4 * 1024 * 1024;
const referencePlanes = {
  xy: {origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0]},
  yz: {origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1]},
  xz: {origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1]},
};
const sketchLabels = {point: '점', line: '선', rectangle: '사각형', circle: '원', ellipse: '타원', arc: '호', ellipseArc: '타원 호'};
const sketchToolHints = {
  move: '스케치 윤곽이나 개별 요소를 끌어 평면에서 옮기세요.',
  arc: '호의 시작점, 통과점, 끝점을 차례로 클릭하세요.',
  'tangent-arc': '기존 선 또는 호의 끝점을 선택한 다음 새 호의 끝점을 클릭하세요.',
  trim: '지울 구간을 가리킨 뒤 강조된 부분을 클릭하세요.',
  split: '선을 나눌 위치를 클릭하세요.',
  round: '둥글게 연결할 두 선을 남겨 둘 쪽에서 차례로 클릭하세요.',
  offset: '연결된 중심선의 선 또는 호를 선택하고 전체 유로 폭을 입력하세요.',
  construction: '닫힌 영역 판정에서 제외하거나 다시 포함할 도형을 클릭하세요.',
  project: '3D 모서리를 클릭해 현재 스케치 평면에 보조선으로 투영하세요.',
};
const sketchJoinTolerance = 1e-7; // Millimetres, matching the model's line-loop tolerance.
const minimumCadDimension = 0.0001;
const sketchGridStep = 1;
const previewInterval = 100;
const numberFormat = new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 3});
const formatNumber = (value) => numberFormat.format(value);
const fields = Object.fromEntries(
  ['x', 'y', 'z', 'width', 'length', 'radius', 'height', 'dx', 'dy', 'dz']
    .map((key) => [key, byId(`field-${key}`)]),
);
const toolInfo = {
  extrude: {heading: '스케치 및 돌출', description: 'XY 평면에서 단면을 정하고 +Z 방향으로 돌출합니다. 부품과 맞닿는 솔리드는 합쳐집니다.', submit: '돌출 만들기'},
  cut: {heading: '스케치 및 절삭', description: '지정한 Z에서 아래로 절삭합니다. 절삭한 체적을 유체 영역으로 선택할 수 있습니다.', submit: '절삭 만들기'},
  move: {heading: '부품 이동', description: '부품 전체를 X, Y, Z 방향으로 지정 거리만큼 이동합니다.', submit: '이동 적용'},
  import: {heading: '가져온 STEP', description: '기존 솔리드에 돌출, 절삭 또는 이동 작업을 추가할 수 있습니다.'},
};

let documentState = emptyDocument();
let model = emptyModel();
let past = [];
let future = [];
let editIndex = null;
let selectedFace = null;
let activeSketchId = null;
let draftSketch = null;
let lastEditedSketchId = null;
let gridShift = null;
let sketchTool = 'select';
let pullMode = 'auto';
let selectedSketchEntity = null;
let activeSketchRegion = null;
let channelSelection = null;
let sketchToolTarget = null;
let invalidFeatureIndex = null;
let preferredReferencePlane = 'xy';
let directEditIndex = null;
let tool = 'extrude';
let moveBodyId = null;
let drawing = false;
let depthActive = false;
let originalDepthHeight = null;
let snapEnabled = true;
let ready = false;
let busy = false;
let viewport = null;
let selectedBodyId = null;
let selectedTreeNode = null;
let cancelTreeRename = null;
let dimensionEdit = null;
let previewGeneration = 0;
let previewTimer = null;
let previewInFlight = false;
let previewStartedAt = -Infinity;
let previewPending = null;
let previewKey = '';

function showMessage(message) {
  byId('cad-message').textContent = message;
  byId('cad-message').hidden = !message;
}

function enableModelTools() {
  const disabled = !ready || busy;
  const hasPart = Boolean(model.part);
  const hasDomain = Boolean(model.domain);
  const hasOperations = documentState.operations.length > 0;
  const editable = ['extrude', 'cut', 'move'].includes(tool);
  byId('feature-fields').disabled = disabled;
  for (const id of ['import-step', 'open-project', 'tool-rectangle', 'tool-circle', 'tool-extrude']) {
    byId(id).disabled = disabled;
  }
  for (const id of ['tool-cut', 'tool-move', 'export-part']) byId(id).disabled = disabled || !hasPart;
  byId('new-project').disabled = disabled || !hasOperations;
  byId('save-project').disabled = busy || !hasOperations;
  byId('export-domain').disabled = disabled || !hasDomain;
  byId('open-flow').disabled = disabled || !hasDomain;
  byId('clear-domain').disabled = disabled || !hasDomain;
  byId('undo').disabled = disabled || !past.length;
  byId('redo').disabled = disabled || !future.length;
  byId('feature-apply').disabled = !editable || (!hasPart && tool !== 'extrude');
  byId('depth-handle').disabled = disabled;
  byId('drag-depth').disabled = disabled || !viewport || (!hasPart && tool === 'cut');
  byId('snap-toggle').disabled = !viewport;
  for (const button of document.querySelectorAll('[data-sketch-tool], [data-sketch-plane], #new-sketch-xy, #finish-sketch, #sketch-mode, #activate-pull, #view-plan')) {
    button.disabled = disabled || !viewport;
  }
  byId('new-sketch-face').disabled = disabled || !viewport || Boolean(activeSketchId) || !selectedSketchPlane();
  document.querySelector('[data-sketch-tool="project"]').disabled = disabled || !viewport || !hasPart;
  byId('pull-mode').disabled = disabled || !viewport || Boolean(activeSketchId);
  byId('merge-sketch-overlaps').disabled = disabled || !mergeableSketchGroups().length;
  byId('delete-element').disabled = disabled || !(selectedSketchEntity || activeSketchRegion || selectedTreeNode);
  byId('view-origin').disabled = !viewport;
  for (const control of byId('direct-form').elements) control.disabled = disabled;
  for (const control of byId('dimension-editor').elements) control.disabled = disabled;
  byId('make-direct-domain').disabled = disabled || documentState.domainCut === directEditIndex;
  byId('viewport').dataset.busy = String(busy);
  for (const node of byId('feature-list').querySelectorAll('button')) node.disabled = disabled;
  for (const button of byId('sketch-profile-list').querySelectorAll('button')) button.disabled = disabled;
  for (const button of byId('sketch-channel-list').querySelectorAll('button')) button.disabled = disabled;
  for (const button of document.querySelectorAll('[data-view]')) button.disabled = !viewport || Boolean(activeSketchId);
  byId('scene-job').hidden = !busy;
}

function setBusy(value) {
  busy = value;
  enableModelTools();
}

async function responseFor(url, state) {
  const response = await fetch(url, state ? {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(state),
  } : {});
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const failure = new Error(error.error || `서버 요청에 실패했습니다 (${response.status}).`);
    if (Number.isInteger(error.operationIndex)) failure.operationIndex = error.operationIndex;
    throw failure;
  }
  return response;
}

function saveLocally(state) {
  try {
    localStorage.setItem(autosaveKey, JSON.stringify(state));
    return true;
  } catch {
    try { localStorage.removeItem(autosaveKey); } catch { /* Storage may be disabled. */ }
    return false;
  }
}

function renderModelInfo() {
  const {part, domain} = model;
  byId('part-state').textContent = part ? '부품' : '빈 모델';
  byId('part-solids').textContent = part ? formatNumber(part.solids) : '—';
  byId('part-volume').textContent = part ? `${formatNumber(part.volume)} mm³` : '—';
  byId('part-bounds').textContent = part
    ? `${part.bounds.slice(3).map((maximum, axis) => formatNumber(maximum - part.bounds[axis])).join(' × ')} mm`
    : '—';
  byId('layer-picker').hidden = !domain;
  byId('domain-volume').hidden = !domain;
  byId('clear-domain').hidden = !domain;
  byId('domain-volume').textContent = domain ? `유체 체적 ${formatNumber(domain.volume)} mm³` : '';
  byId('empty-state').hidden = Boolean(part) || Boolean(activeSketchId) ||
    Boolean(model.sketches?.some((sketch) => sketch.entities.length)) || drawing || depthActive;
}

function isPullCut(operation) {
  return operation.type === 'pull' && (operation.mode === 'cut' || (operation.mode !== 'join' && operation.distance < 0));
}

function featureTitle(operation) {
  if (operation.type === 'import') return operation.name || 'STEP 솔리드';
  if (operation.type === 'move') return '부품 이동';
  if (operation.type === 'sketch') return `스케치 · ${operation.entities.length}개 요소`;
  if (operation.type === 'pull') return isPullCut(operation) ? '스케치 절삭' : '스케치 돌출';
  if (operation.type === 'face_edit') return '면 밀기·당기기';
  if (operation.type === 'cylinder_edit') return '원통 치수 변경';
  if (operation.type === 'fillet') return operation.radius === 0 ? '모서리 필렛 · 0 mm' : '모서리 필렛';
  const profile = operation.profile === 'rectangle' ? '사각형' : '원';
  return `${profile} ${operation.type === 'extrude' ? '돌출' : '절삭'}`;
}

function treeNodeFor(item) {
  const {nodeKind: kind, sketchId, partId, operationIndex} = item.dataset;
  if (kind === 'body') return {kind, id: partId};
  const index = Number(operationIndex);
  return kind === 'sketch' ? {kind, id: sketchId, index} : {kind, index};
}

function sameTreeNode(first, second) {
  return first?.kind === second?.kind && (first?.id ? first.id === second?.id : first?.index === second?.index);
}

function treeName(node, fallback) {
  const names = documentState.names?.[node.kind === 'body' ? 'bodies' : 'sketches'];
  const saved = names && Object.hasOwn(names, node.id) ? names[node.id] : null;
  return typeof saved === 'string' && saved.trim() ? saved.trim().slice(0, 80) : fallback;
}

function treeItems() {
  return Array.from(byId('feature-list').querySelectorAll('[data-node-kind]'));
}

function syncTreeSelection() {
  for (const item of treeItems()) {
    const node = treeNodeFor(item);
    const picked = selectedTreeNode ? sameTreeNode(selectedTreeNode, node) :
      (node.kind === 'body' && node.id === selectedBodyId) ||
      (node.kind === 'sketch' && node.id === activeSketchId) ||
      (node.kind === 'feature' && (node.index === editIndex || node.index === directEditIndex));
    item.querySelector(':scope > .tree-row > .tree-label')?.setAttribute('aria-pressed', String(picked));
    item.dataset.selected = String(picked);
  }
}

function selectBody(bodyId) {
  selectedBodyId = bodyId || null;
  viewport?.setBodySelection?.(selectedBodyId);
  syncTreeSelection();
}

function selectTreeNode(node, bodyId, openFeature = false) {
  if (busy || !ready) return;
  onSketchSelect(null);
  onPick(null);
  if (node.kind === 'sketch' || openFeature) editFeature(node.index);
  else if (activeSketchId) finishSketch();
  selectedTreeNode = node;
  selectBody(bodyId);
  enableModelTools();
}

function treeAction(title, text, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

function renameSelectedTreeNode() {
  if (busy || !ready || !['body', 'sketch'].includes(selectedTreeNode?.kind)) return false;
  const candidates = treeItems().filter((item) => sameTreeNode(treeNodeFor(item), selectedTreeNode));
  const item = candidates.find((candidate) => candidate.contains(document.activeElement)) ??
    candidates.find((candidate) => !candidate.closest('[hidden]'));
  if (!item) return false;
  return beginTreeRename(item);
}

function beginTreeRename(item) {
  if (busy || !ready) return false;
  cancelTreeRename?.();
  const node = treeNodeFor(item);
  onSketchSelect(null);
  onPick(null);
  selectedTreeNode = node;
  const bodyId = item.closest('[data-part-id]')?.dataset.partId ?? null;
  selectBody(bodyId);
  enableModelTools();
  const row = item.querySelector(':scope > .tree-row');
  const label = row.querySelector('.tree-label');
  const rename = row.querySelector('.tree-rename');
  const title = label.title;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tree-name-input';
  input.maxLength = 80;
  input.value = title;
  input.setAttribute('aria-label', `${title} 이름 편집`);
  input.addEventListener('input', () => input.setCustomValidity(''));
  const save = treeAction('이름 저장', '✓', 'tree-rename');
  const stop = () => {
    input.replaceWith(label);
    save.replaceWith(rename);
    cancelTreeRename = null;
    label.focus();
  };
  const commit = async () => {
    if (busy) return;
    const value = input.value.trim();
    if (!value) {
      input.setCustomValidity('이름을 입력하세요.');
      input.reportValidity();
      input.focus();
      return;
    }
    if (value === title) {
      stop();
      return;
    }
    const group = node.kind === 'body' ? 'bodies' : 'sketches';
    const names = {...documentState.names, [group]: {...documentState.names?.[group], [node.id]: value}};
    const treeKey = item.dataset.treeKey;
    input.disabled = true;
    if (await changeDocument({...documentState, names})) {
      selectedTreeNode = node;
      selectBody(bodyId);
      enableModelTools();
      treeItems().find((candidate) => candidate.dataset.treeKey === treeKey)
        ?.querySelector(':scope > .tree-row > .tree-label')?.focus();
    } else {
      input.disabled = false;
      input.focus();
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') commit();
    else stop();
  });
  save.addEventListener('click', commit);
  label.replaceWith(input);
  rename.replaceWith(save);
  cancelTreeRename = stop;
  input.focus();
  input.select();
  return true;
}

function treeItem(node, title, key, bodyId, children, openState) {
  const item = document.createElement('li');
  item.dataset.nodeKind = node.kind;
  item.dataset.treeKey = key;
  if (node.kind === 'body') item.dataset.partId = node.id;
  if (node.kind === 'sketch') item.dataset.sketchId = node.id;
  if (node.index !== undefined) item.dataset.operationIndex = node.index;
  if (node.kind === 'feature' && node.index === invalidFeatureIndex) item.dataset.invalid = 'true';

  const row = document.createElement('div');
  row.className = 'tree-row';
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'tree-label';
  name.title = title;
  if (node.index !== undefined) name.dataset.operationIndex = node.index;
  const glyph = document.createElement('span');
  glyph.className = 'tree-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  const caption = document.createElement('span');
  caption.className = 'feature-type';
  caption.textContent = title;
  name.append(glyph, caption);
  if (node.kind === 'feature' && documentState.domainCut === node.index) {
    const tag = document.createElement('span');
    tag.className = 'domain-tag';
    tag.textContent = '유체';
    name.append(tag);
  }
  name.addEventListener('click', () => {
    selectTreeNode(node, bodyId);
    // Entering a sketch can rebuild the tree. Keep Delete and F2 on the row.
    treeItems().find((candidate) => candidate.dataset.treeKey === key)
      ?.querySelector(':scope > .tree-row > .tree-label')?.focus({preventScroll: true});
  });
  if (node.kind === 'feature') {
    name.setAttribute('aria-keyshortcuts', 'Delete');
    const edit = treeAction(`${title} 편집`, '✎', 'tree-edit');
    edit.addEventListener('click', () => selectTreeNode(node, bodyId, true));
    name.addEventListener('dblclick', () => selectTreeNode(node, bodyId, true));
    row.append(name, edit);
  } else {
    name.setAttribute('aria-keyshortcuts', 'F2 Delete');
    const rename = treeAction(`${title} 이름 변경`, '✎', 'tree-rename');
    rename.addEventListener('click', () => beginTreeRename(item));
    row.append(name, rename);
  }
  item.append(row);

  if (children.length) {
    const branch = document.createElement('ol');
    branch.className = 'tree-children';
    branch.id = `cad-tree-${key}`;
    branch.append(...children);
    const toggle = treeAction(`${title} 접기`, '›', 'tree-toggle');
    toggle.setAttribute('aria-controls', branch.id);
    const setOpen = (open) => {
      const action = `${title} ${open ? '접기' : '펼치기'}`;
      toggle.title = action;
      toggle.setAttribute('aria-label', action);
      toggle.setAttribute('aria-expanded', String(open));
      branch.hidden = !open;
    };
    setOpen(openState.get(key) ?? true);
    toggle.addEventListener('click', () => setOpen(branch.hidden));
    row.prepend(toggle);
    item.append(branch);
  }
  return item;
}

function renderFeatures() {
  const list = byId('feature-list');
  const operations = documentState.operations;
  const bodies = model.bodies ?? [];
  const openState = new Map(treeItems().map((item) =>
    [item.dataset.treeKey, !item.querySelector(':scope > .tree-children')?.hidden]));
  const deleted = new Set(model.deletedOperationIndices ?? []);
  const visible = operations.map((_, index) => index).filter((index) => {
    const operation = operations[index];
    return !deleted.has(index) && operation.type !== 'delete_body' &&
      (operation.type !== 'sketch' || operation.entities.length > 0);
  });
  const visibleSet = new Set(visible);
  const sketchNames = new Map(visible.filter((index) => operations[index].type === 'sketch')
    .map((index, order) => [operations[index].id, `스케치 ${order + 1}`]));
  const historyItems = (indices, bodyId) => {
    const sketches = new Set(indices.filter((index) => operations[index].type === 'sketch')
      .map((index) => operations[index].id));
    const groups = new Map();
    const items = indices.filter((index) => {
      const operation = operations[index];
      if (operation.type !== 'pull' || !sketches.has(operation.sketch)) return true;
      if (!groups.has(operation.sketch)) groups.set(operation.sketch, []);
      groups.get(operation.sketch).push(index);
      return false;
    });
    const feature = (index) => treeItem({kind: 'feature', index}, featureTitle(operations[index]),
      `${bodyId ?? 'root'}-feature-${index}`, bodyId, [], openState);
    return items.map((index) => {
      const operation = operations[index];
      if (operation.type !== 'sketch') return feature(index);
      const node = {kind: 'sketch', index, id: operation.id};
      return treeItem(node, treeName(node, sketchNames.get(node.id)),
        `${bodyId ?? 'root'}-sketch-${node.id}`, bodyId, (groups.get(node.id) ?? []).map(feature), openState);
    });
  };
  const attached = new Set(bodies.flatMap((part) => part.operationIndices));
  const nodes = bodies.map((part, index) => {
    const node = {kind: 'body', id: part.id};
    const indices = [...new Set(part.operationIndices)].filter((op) => visibleSet.has(op)).sort((a, b) => a - b);
    return treeItem(node, treeName(node, `파트 ${index + 1}`), part.id, part.id, historyItems(indices, part.id), openState);
  });
  nodes.push(...historyItems(visible.filter((index) => !attached.has(index)), null));
  byId('features-empty').hidden = nodes.length > 0;
  list.replaceChildren(...nodes);
  cancelTreeRename = null;
  if (selectedTreeNode && !treeItems().some((item) => sameTreeNode(treeNodeFor(item), selectedTreeNode))) selectedTreeNode = null;
  selectBody(bodies.some((part) => part.id === selectedBodyId) ? selectedBodyId : null);
}

function onPick(face) {
  selectedTreeNode = null;
  selectedFace = face;
  viewport?.setSelection(face?.id ?? null);
  selectBody(face?.layer === 'part' ? face.body_id : null);
  syncTreeSelection();
  const isHorizontal = Number.isFinite(face?.plane_z);
  byId('face-info').textContent = face
    ? (isHorizontal ? `선택한 면  ·  Z ${formatNumber(face.plane_z)} mm` : selectedSketchPlane() ? '선택한 평면 면' : '선택한 곡면')
    : '선택된 면 없음';
  byId('use-face').disabled = !isHorizontal;
  byId('new-sketch-face').disabled = !ready || busy || !viewport || Boolean(activeSketchId) || !selectedSketchPlane();
  byId('delete-element').disabled = !ready || busy || !(selectedSketchEntity || activeSketchRegion);
}

function selectedSketchPlane() {
  return selectedFace?.layer === 'domain' ? null : selectedFace?.plane ?? null;
}

function sketchNormal({x, y}) {
  return [
    x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0],
  ];
}

function sameSketchPlane(first, second) {
  const dot = (a, b) => a.reduce((total, value, index) => total + value * b[index], 0);
  const direction = sketchNormal(first);
  return dot(direction, sketchNormal(second)) >= 1 - 1e-8 &&
    Math.abs(dot(direction, second.origin.map((value, index) => value - first.origin[index]))) <= sketchJoinTolerance;
}

function referencePlaneOf(sketch) {
  if (!sketch) return null;
  const command = documentState.operations[sketchOperationIndex(sketch.id)] ?? sketch;
  if (command.body || sketch.body_id) return null;
  return Object.keys(referencePlanes).find((key) => sameSketchPlane(referencePlanes[key], sketch.plane)) ?? null;
}

function matchingSketch(plane, bodyId, faceRef) {
  const candidates = (model.sketches ?? []).filter((sketch) => {
    if (!sketch.entities.length || !sameSketchPlane(plane, sketch.plane)) return false;
    const command = documentState.operations[sketchOperationIndex(sketch.id)];
    if (bodyId) return sketch.body_id === bodyId;
    return !command?.body && !sketch.body_id;
  });
  if (!bodyId) return candidates.at(-1);
  const binding = (sketch) => documentState.operations[sketchOperationIndex(sketch.id)]?.faceRef;
  const exact = candidates.findLast((sketch) => binding(sketch) === faceRef);
  if (exact) return exact;
  const liveRefs = new Set(model.part?.faces.filter((face) => face.body_id === bodyId).map((face) => face.ref));
  const unbound = candidates.filter((sketch) => !liveRefs.has(binding(sketch)));
  return unbound.length === 1 ? unbound[0] : null;
}

function currentSketch() {
  return model.sketches?.find((sketch) => sketch.id === activeSketchId) ?? draftSketch;
}

function lastEditedSketch() {
  return model.sketches?.find((sketch) => sketch.id === lastEditedSketchId) ?? model.sketches?.at(-1);
}

function sketchOperationIndex(id) {
  return documentState.operations.findIndex((operation) => operation.type === 'sketch' && operation.id === id);
}

function editableChannels(operation) {
  if (!Array.isArray(operation?.channels)) return [];
  const entities = new Map(operation.entities.map((entity) => [entity.id, entity]));
  const owned = new Set(), ids = new Set();
  return operation.channels.filter((channel) => {
    if (!channel || typeof channel.id !== 'string' || ids.has(channel.id) ||
        !Number.isFinite(channel.width) || channel.width < minimumCadDimension ||
        !Array.isArray(channel.centerlineIds) || !channel.centerlineIds.length ||
        !Array.isArray(channel.outlineIds) || !channel.outlineIds.length ||
        !Array.isArray(channel.outlineSources) || channel.outlineSources.length !== channel.outlineIds.length ||
        !channel.centerlineIds.includes(channel.seedId)) return false;
    const members = [...channel.centerlineIds, ...channel.outlineIds];
    if (members.length !== new Set(members).size || members.some((id) => !entities.has(id) || owned.has(id)) ||
        channel.centerlineIds.some((id) => !entities.get(id).construction || !['line', 'arc'].includes(entities.get(id).kind)) ||
        channel.outlineIds.some((id) => entities.get(id).construction || !['line', 'arc'].includes(entities.get(id).kind)) ||
        channel.outlineSources.some((id) => id !== null && !channel.centerlineIds.includes(id))) return false;
    ids.add(channel.id);
    for (const id of members) owned.add(id);
    return true;
  });
}

function channelMember(channel, id) {
  return channel.centerlineIds.includes(id) || channel.outlineIds.includes(id);
}

function channelForEntity(operation, entityId) {
  return editableChannels(operation).find((channel) => channelMember(channel, entityId));
}

function mergeableSketchGroups(sketch = currentSketch()) {
  if (!sketch?.overlapGroups?.length) return [];
  const merged = new Set(documentState.operations[sketchOperationIndex(sketch.id)]?.mergeRegions);
  return sketch.overlapGroups.filter((group) => !group.some((id) => merged.has(id)));
}

function sketchHint() {
  if (sketchTool === 'round' && sketchToolTarget) return '코너를 이을 두 번째 선을 클릭하세요.';
  if (sketchToolHints[sketchTool]) return sketchToolHints[sketchTool];
  if (sketchTool === 'point') return '평면을 클릭해 점을 놓으세요.';
  if (sketchTool === 'line') return '두 점을 클릭하거나 드래그하세요. 그리는 중 숫자 또는 Space로 치수를 입력합니다.';
  if (sketchTool !== 'select') return `${sketchLabels[sketchTool]}의 두 기준점을 정하세요. 그리는 중 숫자 또는 Space로 치수를 입력합니다.`;
  if (activeSketchId) return '영역 안쪽을 끌어 스케치를 옮기고 윤곽선을 끌어 치수를 바꾸세요. 겹친 스케치는 목록에서도 선택할 수 있습니다.';
  if (model.sketches?.some((sketch) => sketch.regions?.length)) return '스케치 영역을 끌어 돌출·결합 또는 절삭을 적용하세요.';
  if (model.part) return '면을 끌어 크기를 바꾸거나 모서리를 안쪽으로 끌어 필렛을 적용하세요. 두 번 클릭하면 치수를 입력할 수 있습니다.';
  return '왼쪽 아래 삼축에서 기준면을 선택하거나, 3D 평면 면에서 스케치를 시작하세요.';
}

function syncSketchViewport() {
  if (!viewport) return;
  const pulledRegions = new Map();
  const deleted = new Set(model.deletedOperationIndices);
  for (const [index, operation] of documentState.operations.entries()) {
    if (operation.type !== 'pull' || deleted.has(index)) continue;
    if (!pulledRegions.has(operation.sketch)) pulledRegions.set(operation.sketch, []);
    pulledRegions.get(operation.sketch).push(operation.region);
  }
  const sketches = (model.sketches ?? []).map((entry) => {
    const operation = documentState.operations[sketchOperationIndex(entry.id)];
    const body = entry.body_id ?? operation?.body;
    return {...entry, body_id: model.bodies?.some((part) => part.id === body) ? body : null,
      pulledRegionIds: pulledRegions.get(entry.id) ?? [], editableChannels: editableChannels(operation)};
  });
  if (draftSketch) sketches.push(draftSketch);
  viewport.setSketchWorkspace({sketches, activeId: activeSketchId, activeRegion: activeSketchRegion,
    tool: sketchTool, pullMode, selectedEntity: selectedSketchEntity, toolTarget: sketchToolTarget, channelSelection});
}

function syncProfileSelection() {
  for (const button of byId('sketch-profile-list').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.profileId === activeSketchRegion));
  }
}

function renderSketchProfiles(sketch) {
  const profiles = sketch?.profiles ?? [];
  if (!profiles.some((profile) => profile.id === activeSketchRegion)) activeSketchRegion = null;
  const entries = profiles.map((profile, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.profileId = profile.id;
    button.textContent = `스케치 ${index + 1}`;
    button.onclick = () => {
      if (sketchTool !== 'select' && sketchTool !== 'move') chooseSketchTool('select');
      onSketchSelect({kind: 'region', sketch: sketch.id, region: profile.id});
    };
    item.append(button);
    return item;
  });
  byId('sketch-profile-list').replaceChildren(...entries);
  byId('sketch-profiles').hidden = !profiles.length;
  syncProfileSelection();
}

function renderSketchChannels(operation) {
  const channels = editableChannels(operation);
  if (!channels.some((channel) => channel.id === channelSelection)) channelSelection = null;
  const rows = channels.map((channel, index) => {
    const row = document.createElement('li');
    row.className = 'sketch-channel';
    row.dataset.channelId = channel.id;
    row.dataset.selected = String(channel.id === channelSelection);
    const title = document.createElement('p');
    title.textContent = `유로 ${index + 1} · 폭 ${formatNumber(channel.width)} mm`;
    const actions = document.createElement('div');
    actions.className = 'sketch-channel-actions';
    const add = (label, action, handle, arcId = null) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.channelEdit = action;
      if (arcId) button.dataset.arcId = arcId;
      button.onclick = handle;
      actions.append(button);
    };
    const edit = (event, arcId = null) => {
      selectChannel(channel.id);
      const bounds = event.currentTarget.getBoundingClientRect();
      openDimensionEditor(channelDimension(operation.id, channel, arcId), [bounds.left, bounds.top]);
    };
    add('폭 편집', 'width', edit);
    const turns = operation.entities.filter((entity) => entity.kind === 'arc' && channel.centerlineIds.includes(entity.id));
    for (const [turn, arc] of turns.entries()) {
      add(`턴 ${turn + 1} · R${formatNumber(arc.radius)}`, 'radius', (event) => edit(event, arc.id), arc.id);
    }
    add('연결 해제', 'detach', () => detachSketchChannel(operation.id, channel.id));
    row.append(title, actions);
    return row;
  });
  byId('sketch-channel-list').replaceChildren(...rows);
  byId('sketch-channels').hidden = !rows.length;
}

function selectChannel(id) {
  channelSelection = id;
  for (const row of byId('sketch-channel-list').children) row.dataset.selected = String(row.dataset.channelId === id);
  syncSketchViewport();
}

function renderSketchWorkspace() {
  const sketch = currentSketch();
  const reference = referencePlaneOf(sketch);
  const editing = Boolean(sketch);
  const mode = editing ? 'sketch' : 'model';
  byId('workspace-mode').textContent = editing ? '2D 스케치 편집' : '3D 모델링';
  byId('workspace-mode').dataset.mode = mode;
  byId('viewport').dataset.mode = mode;
  byId('cad-canvas').setAttribute('aria-label', editing
    ? '2D 스케치 평면. 닫힌 영역을 끌어 움직입니다.'
    : '3D 모델. 스케치 영역을 끌어 돌출 또는 절삭합니다.');
  byId('sketch-plane-info').hidden = !editing;
  const offset = gridShift?.offset;
  byId('sketch-plane-info').textContent = offset
    ? `오프셋 스케치 · ${offset > 0 ? '+' : ''}${formatNumber(offset)} mm`
    : reference ? `${reference.toUpperCase()} 기준면 스케치` : sketch?.body_id ? '선택면 스케치' : '작업 평면 스케치';
  for (const button of document.querySelectorAll('[data-sketch-plane]')) {
    button.setAttribute('aria-pressed', String(button.dataset.sketchPlane === reference));
  }
  byId('sketch-region-info').hidden = !sketch;
  byId('sketch-region-info').textContent = sketch ? `요소 ${sketch.entities.length} · 3D 영역 ${sketch.regions?.length ?? 0}` : '';
  const openCount = sketch?.openPoints?.length ?? 0;
  byId('sketch-open-info').hidden = !openCount;
  byId('sketch-open-info').textContent = openCount ? `열린 끝점 ${openCount}개. 강조점에서 선을 잇거나 보조선으로 전환하세요.` : '';
  byId('sketch-edit-tools').hidden = !editing;
  const command = sketch && documentState.operations[sketchOperationIndex(sketch.id)];
  byId('sketch-merge-info').hidden = !command?.mergeRegions?.length;
  byId('sketch-instructions').textContent = sketchHint();
  byId('sketch-mode').hidden = editing;
  byId('sketch-move').hidden = !editing;
  byId('finish-sketch').hidden = !editing;
  byId('pull-mode-field').hidden = editing;
  byId('merge-sketch-overlaps').hidden = !editing;
  for (const button of document.querySelectorAll('[data-sketch-tool]')) {
    button.setAttribute('aria-pressed', String(editing && button.dataset.sketchTool === sketchTool));
  }
  renderSketchProfiles(sketch);
  renderSketchChannels(command);
  syncSketchViewport();
  renderGestureControls();
  renderFeatures();
  enableModelTools();
}

function setSketchInteraction(id, nextTool = 'select', draft = null) {
  if (id !== activeSketchId) {
    gridShift = null;
    channelSelection = null;
  }
  if (id !== activeSketchId || nextTool !== sketchTool) sketchToolTarget = null;
  if (id !== activeSketchId || !['select', 'move'].includes(nextTool)) {
    selectedSketchEntity = null;
    activeSketchRegion = null;
  }
  selectedTreeNode = null;
  activeSketchId = id;
  if (id) lastEditedSketchId = id;
  sketchTool = nextTool;
  draftSketch = draft;
}

function startSketch(plane, nextTool = 'select', bodyId = null, faceRef = null, options = {}) {
  if (!plane || busy || !ready || !viewport) return;
  closeDimensionEditor();
  if (drawing) changeDrawing(false);
  if (depthActive) changeDepth(false);
  directEditIndex = null;
  editIndex = null;
  byId('direct-form').hidden = true;
  byId('legacy-operations').open = false;
  const existing = model.sketches?.find((sketch) => sketch.id === options.existingId) ??
    matchingSketch(plane, bodyId, faceRef);
  if (existing) {
    setSketchInteraction(existing.id, nextTool);
  } else {
    const draft = {type: 'sketch', id: `s-${crypto.randomUUID()}`, plane, entities: [], profiles: [], regions: []};
    if (bodyId) Object.assign(draft, {body_id: bodyId, faceRef});
    setSketchInteraction(draft.id, nextTool, draft);
  }
  gridShift = options.shift ?? null;
  renderSketchWorkspace();
}

function startReferenceSketch(key, nextTool = 'select') {
  preferredReferencePlane = key;
  startSketch(referencePlanes[key], nextTool);
}

function openSketchFromShortcut(nextTool = 'select') {
  if (activeSketchId) {
    if (nextTool !== 'select') chooseSketchTool(nextTool);
    return;
  }
  const selected = selectedSketchPlane();
  if (selected) return startSketch(selected, nextTool, selectedFace.body_id, selectedFace.ref);
  const previous = lastEditedSketch();
  if (previous) return startSketch(previous.plane, nextTool, previous.body_id, null, {existingId: previous.id});
  return startReferenceSketch(preferredReferencePlane, nextTool);
}

function shiftSketchGrid(direction) {
  const current = currentSketch();
  if (!current) return;
  const command = documentState.operations[sketchOperationIndex(current.id)];
  const source = gridShift ?? {
    id: current.id, plane: current.plane, body: current.body_id, faceRef: command?.faceRef ?? current.faceRef, offset: 0,
  };
  const offset = source.offset + direction * sketchGridStep;
  if (!offset) return startSketch(source.plane, sketchTool, source.body, source.faceRef, {existingId: source.id});
  const normal = sketchNormal(source.plane);
  const origin = source.plane.origin.map((value, axis) => value + offset * normal[axis]);
  if (origin.some((coordinate) => Math.abs(coordinate) > 1_000_000)) return;
  startSketch({...source.plane, origin}, sketchTool, null, null, {shift: {...source, offset}});
}

function showSketchPlan() {
  const plane = currentSketch()?.plane ?? selectedSketchPlane() ?? lastEditedSketch()?.plane ?? referencePlanes[preferredReferencePlane];
  viewport?.viewSketchPlane(plane);
}

function chooseSketchTool(nextTool) {
  if (busy || !ready || !viewport) return;
  closeDimensionEditor();
  if (!activeSketchId && nextTool !== 'select') {
    const plane = selectedSketchPlane();
    if (plane) startSketch(plane, nextTool, selectedFace.body_id, selectedFace.ref);
    else startReferenceSketch(preferredReferencePlane, nextTool);
    return;
  }
  if (drawing) changeDrawing(false);
  if (depthActive) changeDepth(false);
  byId('legacy-operations').open = false;
  setSketchInteraction(activeSketchId, nextTool, draftSketch);
  renderSketchWorkspace();
}

function finishSketch() {
  if (busy) return;
  closeDimensionEditor();
  setSketchInteraction(null);
  renderSketchWorkspace();
}

function returnToModeling() {
  if (drawing) changeDrawing(false);
  if (depthActive) changeDepth(false);
  finishSketch();
}

function activatePull() {
  directEditIndex = null;
  byId('direct-form').hidden = true;
  byId('legacy-operations').open = false;
  returnToModeling();
}

function activateMove() {
  if (activeSketchId) {
    chooseSketchTool('move');
    return;
  }
  if (!model.part) return false;
  closeDimensionEditor();
  directEditIndex = null;
  byId('direct-form').hidden = true;
  byId('legacy-operations').open = true;
  setTool('move', {body: selectedBodyId});
  fields.dx.focus();
}

async function onSketchCreate(entity) {
  const selected = currentSketch();
  if (busy || !selected || !Object.hasOwn(sketchLabels, entity.kind)) return;
  const operations = documentState.operations.slice();
  const index = sketchOperationIndex(selected.id);
  const created = {...entity, id: `e-${crypto.randomUUID()}`};
  const command = {...operations[index], type: 'sketch', id: selected.id, plane: selected.plane,
    entities: [...selected.entities, created]};
  const bodyId = operations[index]?.body ?? draftSketch?.body_id;
  if (bodyId) command.body = bodyId;
  if (draftSketch?.faceRef) command.faceRef = draftSketch.faceRef;
  if (index < 0) operations.push(command);
  else operations[index] = command;
  const isClosed = !entity.construction && ['rectangle', 'circle', 'ellipse'].includes(entity.kind);
  await changeDocument({...documentState, operations}, 'edit', {
    id: selected.id, tool: isClosed ? 'select' : sketchTool, region: isClosed ? created.id : null,
    entity: isClosed ? null : {sketchId: selected.id, entityId: created.id},
  });
}

function replaceSketchCurves(sketch, ids, replacement, tool = sketchTool, newChannel = null) {
  const index = sketchOperationIndex(sketch.id);
  if (index < 0 || !ids.size) return false;
  const operations = documentState.operations.slice();
  const command = operations[index];
  const channels = editableChannels(command);
  if (channels.some((channel) => [...ids].some((id) => channelMember(channel, id)))) {
    throw new Error('이 곡선은 유로에 연결되어 있습니다. 개별 편집은 유로 치수에서 연결 해제한 뒤 할 수 있습니다.');
  }
  const first = command.entities.findIndex((entity) => ids.has(entity.id));
  if (first < 0) return false;
  const entities = command.entities.filter((entity) => !ids.has(entity.id));
  entities.splice(first, 0, ...replacement);
  if (!entities.length) return changeDocument(withoutOperations(documentState, new Set([index])), 'edit', {id: null});
  operations[index] = {...command, entities};
  if (newChannel) operations[index].channels = [...channels, newChannel];
  if (command.mergeRegions) {
    const retained = new Set(entities.map((entity) => entity.id));
    operations[index].mergeRegions = command.mergeRegions.filter((id) => !ids.has(id) || retained.has(id));
  }
  return changeDocument({...documentState, operations}, 'edit', {
    id: sketch.id, tool, region: null, ...(newChannel && {channel: newChannel.id}),
  });
}

const newSketchEntityId = () => `e-${crypto.randomUUID()}`;

function reflowChannel(operation, channel, width, entityId = null, change = null) {
  const byEntityId = new Map(operation.entities.map((entity) => [entity.id, entity]));
  const source = channel.centerlineIds.map((id) => byEntityId.get(id));
  const moved = entityId ? editConnectedSketchCurve(source, entityId, change) : source;
  const rebuilt = buildSketchChannel(moved, width, (index) => channel.outlineIds[index], channel.seedId);
  if (rebuilt.outline.length !== channel.outlineIds.length ||
      rebuilt.outlineSources.some((id, index) => id !== channel.outlineSources[index])) {
    throw new Error('중심선의 연결 순서가 바뀌었습니다. 연결 해제 후 새 중심선에서 유로를 다시 만들 수 있습니다.');
  }
  const changed = new Map([...rebuilt.centerline, ...rebuilt.outline].map((entity) => [entity.id, entity]));
  return {
    ...operation,
    entities: operation.entities.map((entity) => changed.get(entity.id) ?? entity),
    channels: editableChannels(operation).map((item) => item.id === channel.id ? {...item, width} : item),
  };
}

function planSketchEdit(operation, entityId, change) {
  const entity = operation.entities.find((item) => item.id === entityId);
  if (!entity) return operation;
  const channel = channelForEntity(operation, entityId);
  if (channel?.centerlineIds.includes(entityId)) return reflowChannel(operation, channel, channel.width, entityId, change);
  if (channel) {
    const arcId = channel.outlineSources[channel.outlineIds.indexOf(entityId)];
    const arc = operation.entities.find((item) => item.id === arcId && item.kind === 'arc');
    if (entity.kind === 'arc' && arc && Number.isFinite(change.radius)) {
      const radius = arc.radius + (change.radius - entity.radius);
      return reflowChannel(operation, channel, channel.width, arcId, {radius});
    }
    throw new Error('유로의 개별 벽은 유로 치수에서 편집할 수 있습니다.');
  }
  const channels = editableChannels(operation);
  const independent = operation.entities.filter((item) => !channels.some((channel) => channelMember(channel, item.id)));
  const changed = new Map(editConnectedSketchCurve(independent, entityId, change).map((item) => [item.id, item]));
  return {...operation, entities: operation.entities.map((item) => changed.get(item.id) ?? item)};
}

function previewSketchEdit(sketchId, entityId, change) {
  const operation = documentState.operations[sketchOperationIndex(sketchId)];
  const entity = operation?.entities.find((item) => item.id === entityId);
  if (!entity || (entity.kind !== 'arc' && !channelForEntity(operation, entityId))) return null;
  try {
    return planSketchEdit(operation, entityId, change).entities;
  } catch {
    return null;
  }
}

function changeSketchOperation(sketchId, next, interaction) {
  const index = sketchOperationIndex(sketchId);
  if (busy || index < 0 || activeSketchId !== sketchId) return false;
  const operations = documentState.operations.slice();
  operations[index] = next;
  return changeDocument({...documentState, operations}, 'edit', {id: sketchId, ...interaction});
}

function detachSketchChannel(sketchId, channelId) {
  const operation = documentState.operations[sketchOperationIndex(sketchId)];
  if (!operation) return false;
  closeDimensionEditor();
  const channels = editableChannels(operation).filter((channel) => channel.id !== channelId);
  return changeSketchOperation(sketchId, {...operation, channels}, {tool: 'select', channel: null});
}

function projectSketchCurve(plane, curve) {
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const local = (point) => {
    const offset = point.map((value, axis) => value - plane.origin[axis]);
    return [dot(offset, plane.x), dot(offset, plane.y)];
  };
  const [x1, y1] = local(curve.start);
  const [x2, y2] = local(curve.end);
  if (curve.kind === 'line') {
    if (Math.hypot(x2 - x1, y2 - y1) < minimumCadDimension) return {kind: 'point', x: x1, y: y1};
    return {kind: 'line', x1, y1, x2, y2};
  }
  if (Math.hypot(dot(curve.normal, plane.x), dot(curve.normal, plane.y)) > 1e-7) {
    throw new Error('원형 모서리는 스케치와 평행한 면에서 투영할 수 있습니다.');
  }
  const [x, y] = local(curve.center);
  if (curve.kind === 'circle') return {kind: 'circle', x, y, radius: curve.radius};
  const [mx, my] = local(curve.middle);
  const startAngle = Math.atan2(y1 - y, x1 - x);
  const turn = 2 * Math.PI;
  const forward = (angle) => (angle - startAngle + turn) % turn;
  const end = forward(Math.atan2(y2 - y, x2 - x));
  const sweep = forward(Math.atan2(my - y, mx - x)) < end ? end : end - turn;
  return {kind: 'arc', x, y, radius: curve.radius, startAngle, sweep};
}

function openSketchToolDimension(title, field, at, apply) {
  openDimensionEditor({title, inputs: [field], async apply(values) {
    try {
      return await apply(values[field.key]);
    } catch (error) {
      showMessage(error.message);
      return false;
    }
  }}, at);
}

function onSketchToolPick({tool, sketchId, entityId, curve, point, at, edge, segmentIndex}) {
  const sketch = currentSketch();
  if (busy || !ready || sketch?.id !== sketchId || sketchTool !== tool) return;
  showMessage('');
  try {
    if (tool === 'project') {
      if (!edge?.curve) throw new Error('직선 또는 스케치 평면과 평행한 원형 모서리를 선택하세요.');
      const projected = projectSketchCurve(sketch.plane, edge.curve);
      return onSketchCreate({...projected, construction: true});
    }
    const entity = sketch.entities.find((item) => item.id === entityId);
    if (!entity) return;
    const ids = new Set([entity.id]);
    if (tool === 'construction') {
      const {construction, ...active} = entity;
      return replaceSketchCurves(sketch, ids, [construction ? active : {...entity, construction: true}]);
    }
    if (tool === 'trim') {
      const retained = trimSketchSegment(sketch.segments ?? [], entity.id, segmentIndex, newSketchEntityId, entity);
      return replaceSketchCurves(sketch, ids, retained);
    }
    if (tool === 'split') {
      if (['line', 'arc', 'circle', 'ellipse', 'ellipseArc'].includes(entity.kind)) {
        return replaceSketchCurves(sketch, ids, splitSketchCurve(entity, point, newSketchEntityId()));
      }
      if (entity.kind !== 'rectangle' || curve?.kind !== 'line') throw new Error('분할할 선 또는 원호를 선택하세요.');
      const pieces = (sketch.segments ?? []).filter((segment) => segment.entityId === entity.id);
      const retained = pieces.flatMap((segment, index) => {
        const part = {...segment.curve, id: index ? newSketchEntityId() : entity.id};
        return segment === sketch.segments[segmentIndex] ? splitSketchCurve(part, point, newSketchEntityId()) : [part];
      });
      return replaceSketchCurves(sketch, ids, retained);
    }
    if (tool === 'round') {
      if (entity.kind !== 'line') throw new Error('코너에 모이는 직선 두 개를 선택하세요.');
      if (!sketchToolTarget || sketchToolTarget.entityId === entity.id) {
        sketchToolTarget = {entityId: entity.id, point};
        byId('sketch-instructions').textContent = sketchHint();
        syncSketchViewport();
        return;
      }
      const first = sketch.entities.find((item) => item.id === sketchToolTarget.entityId);
      const firstPick = sketchToolTarget.point;
      ids.add(first.id);
      return openSketchToolDimension('코너 라운드', dimensionField('radius', '반지름', 1, minimumCadDimension), at,
        (radius) => replaceSketchCurves(sketch, ids,
          roundSketchCorner(first, entity, radius, newSketchEntityId(), firstPick, point), 'select'));
    }
    if (tool === 'offset') {
      const operation = documentState.operations[sketchOperationIndex(sketch.id)];
      const existing = channelForEntity(operation, entity.id);
      if (existing) {
        selectChannel(existing.id);
        return openDimensionEditor(channelDimension(sketch.id, existing), at);
      }
      return openSketchToolDimension('양쪽 유로 벽', dimensionField('width', '전체 폭', 1, minimumCadDimension), at, (width) => {
        const {centerline, outline, outlineSources} = buildSketchChannel(sketch.entities, width, newSketchEntityId, entity.id);
        const channel = {
          id: `channel-${crypto.randomUUID()}`, width, seedId: entity.id,
          centerlineIds: centerline.map((item) => item.id), outlineIds: outline.map((item) => item.id), outlineSources,
        };
        return replaceSketchCurves(sketch, new Set(channel.centerlineIds), [...centerline, ...outline], 'select', channel);
      });
    }
  } catch (error) {
    showMessage(error.message);
  }
}

function onSketchEdit(sketchId, entityId, change) {
  const index = sketchOperationIndex(sketchId);
  if (busy || index < 0 || activeSketchId !== sketchId) return false;
  const operation = documentState.operations[index];
  try {
    const next = planSketchEdit(operation, entityId, change);
    if (next === operation) return false;
    const channel = channelForEntity(operation, entityId);
    return changeSketchOperation(sketchId, next, {tool: sketchTool === 'move' ? 'move' : 'select', channel: channel?.id ?? null});
  } catch (error) {
    showMessage(error.message);
    return false;
  }
}

function onSketchSelect(target) {
  if (busy || !ready) return;
  selectedTreeNode = null;
  const isRegion = target?.kind === 'region';
  activeSketchRegion = isRegion && target.sketch === activeSketchId ? target.region : null;
  selectedSketchEntity = isRegion ? null : target;
  const geometry = currentSketch();
  const operation = documentState.operations[sketchOperationIndex(geometry?.id)];
  const profile = geometry?.profiles?.find((item) => item.id === activeSketchRegion);
  const channel = profile ? editableChannels(operation).find((item) =>
    item.outlineIds.every((id) => profile.entityIds.includes(id))) : channelForEntity(operation, target?.entityId);
  syncProfileSelection();
  syncTreeSelection();
  selectChannel(channel?.id ?? null);
  enableModelTools();
}

function onSketchMove(sketchId, regionId, dx, dy) {
  if (busy || !ready || sketchId !== activeSketchId || !Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return false;
  const profile = currentSketch()?.profiles?.find((item) => item.id === regionId);
  const index = sketchOperationIndex(sketchId);
  if (!profile || index < 0) return false;
  const ids = new Set(profile.entityIds);
  const operations = documentState.operations.slice();
  const command = operations[index];
  const channels = editableChannels(command).filter((channel) => channel.outlineIds.some((id) => ids.has(id)));
  if (channels.some((channel) => !channel.outlineIds.every((id) => ids.has(id)))) {
    showMessage('유로 전체를 선택하거나 연결 해제한 뒤 일부 곡선을 옮기세요.');
    return false;
  }
  for (const channel of channels) for (const id of channel.centerlineIds) ids.add(id);
  const entities = command.entities.map((entity) => {
    if (!ids.has(entity.id)) return entity;
    if (entity.kind === 'line') return {...entity, x1: entity.x1 + dx, y1: entity.y1 + dy, x2: entity.x2 + dx, y2: entity.y2 + dy};
    return {...entity, x: entity.x + dx, y: entity.y + dy};
  });
  operations[index] = {...command, entities};
  return changeDocument({...documentState, operations}, 'edit', {
    id: sketchId, tool: sketchTool, region: regionId, channel: channels[0]?.id ?? null,
  });
}

function mergeSketchOverlaps(region = null) {
  const sketch = currentSketch();
  if (!sketch || busy || !ready) return false;
  const groups = mergeableSketchGroups(sketch).filter((group) => !region || group.includes(region));
  if (!groups.length) return false;
  const index = sketchOperationIndex(sketch.id);
  if (index < 0) return false;
  const operations = documentState.operations.slice();
  const command = operations[index];
  const mergeRegions = [...new Set([...(command.mergeRegions ?? []), ...groups.flat()])];
  operations[index] = {...command, mergeRegions};
  return changeDocument({...documentState, operations}, 'edit', {id: sketch.id, tool: 'select'});
}

function withoutOperations(state, removed, operations = state.operations) {
  const sketchIds = new Set([...removed]
    .filter((index) => operations[index]?.type === 'sketch')
    .map((index) => operations[index].id));
  const newIndices = new Map();
  // Body IDs encode the operation that first produced the solid and its ordinal.
  const remapBody = (id) => {
    const match = /^body-(\d+)-(\d+)$/.exec(id);
    if (!match) return id;
    const source = newIndices.get(Number(match[1]) - 1);
    return source === undefined ? null : `body-${source + 1}-${match[2]}`;
  };
  const retained = [];
  for (const [index, operation] of operations.entries()) {
    if (removed.has(index) || (operation.type === 'pull' && sketchIds.has(operation.sketch))) continue;
    const body = operation.body && remapBody(operation.body);
    if (operation.body && !body) continue;
    newIndices.set(index, retained.length);
    retained.push(body !== operation.body ? {...operation, body} : operation);
  }
  const next = {...state, operations: retained, domainCut: newIndices.get(state.domainCut) ?? null};
  if (state.names) {
    const sketches = Object.entries(state.names.sketches ?? {}).filter(([id]) => !sketchIds.has(id));
    const bodies = Object.entries(state.names.bodies ?? {})
      .map(([id, name]) => [remapBody(id), name]).filter(([id]) => id !== null);
    next.names = {sketches: Object.fromEntries(sketches), bodies: Object.fromEntries(bodies)};
  }
  return next;
}

function removeEmptySketches(state) {
  const empty = new Set(state.operations.flatMap((operation, index) =>
    operation?.type === 'sketch' && Array.isArray(operation.entities) && !operation.entities.length ? [index] : []));
  return empty.size ? withoutOperations(state, empty) : state;
}

function deleteSketchGeometry() {
  const profile = currentSketch()?.profiles?.find((item) => item.id === activeSketchRegion);
  if (!selectedSketchEntity && !profile) return false;
  const {sketchId, entityId, overlapRegion} = selectedSketchEntity ?? {sketchId: activeSketchId};
  if (overlapRegion) return mergeSketchOverlaps(overlapRegion);
  const index = sketchOperationIndex(sketchId);
  if (index < 0) return false;
  const operations = documentState.operations.slice();
  const command = operations[index];
  const selected = new Set(profile?.entityIds ?? [entityId]);
  const channels = editableChannels(command);
  const touched = channels.filter((channel) => [...selected].some((id) => channelMember(channel, id)));
  if (touched.some((channel) => !channel.outlineIds.every((id) => selected.has(id)))) {
    showMessage('유로 전체를 선택하거나 유로 치수에서 연결 해제한 뒤 개별 곡선을 지우세요.');
    return false;
  }
  for (const channel of touched) for (const id of channel.centerlineIds) selected.add(id);
  const entities = command.entities.filter((entity) => !selected.has(entity.id));
  if (entities.length === command.entities.length) return false;
  if (!entities.length) {
    return changeDocument(withoutOperations(documentState, new Set([index])), 'edit', {id: null});
  }
  const geometry = currentSketch();
  const affectedProfiles = new Set([...(geometry?.profiles ?? []), ...(geometry?.regions ?? [])]
    .filter((item) => item.entityIds.some((id) => selected.has(id)))
    .map((item) => item.id));
  operations[index] = {...command, entities};
  if (touched.length) operations[index].channels = channels.filter((channel) => !touched.includes(channel));
  if (command.mergeRegions) operations[index].mergeRegions = command.mergeRegions.filter((id) => !affectedProfiles.has(id));
  const removed = new Set();
  for (const [step, operation] of operations.entries()) {
    if (operation.type === 'pull' && operation.sketch === sketchId && affectedProfiles.has(operation.region)) removed.add(step);
  }
  const next = removed.size ? withoutOperations(documentState, removed, operations) : {...documentState, operations};
  return changeDocument(next, 'edit', {id: sketchId, tool: 'select', region: null});
}

function deleteSelectedElement() {
  if (busy || !ready) return false;
  if (selectedSketchEntity || activeSketchRegion) return deleteSketchGeometry();
  const node = selectedTreeNode;
  if (!node) return false;
  if (node.kind === 'body') {
    const next = directDocument({type: 'delete_body', body: node.id});
    return next ? changeDocument(next, 'edit', {id: null}) : false;
  }
  const index = node.kind === 'sketch' ? sketchOperationIndex(node.id) : node.index;
  if (!documentState.operations[index]) return false;
  const interaction = activeSketchId && documentState.operations[index].id !== activeSketchId ? {id: activeSketchId} : {id: null};
  return changeDocument(withoutOperations(documentState, new Set([index])), 'edit', interaction);
}

function directDocument(operation) {
  const {index, ...command} = operation;
  const operations = documentState.operations.slice();
  if (command.type === 'fillet') {
    if (!Number.isFinite(command.radius) || command.radius < 0) return null;
    if (Number.isInteger(index)) {
      const previous = operations[index];
      if (previous?.type !== 'fillet' || previous.radius === command.radius) return null;
      // Replay must use the original sharp edge, before this fillet is applied.
      operations[index] = {...previous, radius: command.radius};
      return {...documentState, operations};
    }
    if (typeof command.edge !== 'string' || command.radius === 0) return null;
  } else if (command.type === 'face_edit' || command.type === 'pull') {
    if (!Number.isFinite(command.distance) || command.distance === 0) return null;
    if (command.type === 'pull') {
      if (command.mode === 'auto') delete command.mode;
      if (!command.body) {
        const owner = model.sketches?.find((sketch) => sketch.id === command.sketch)?.body_id;
        if (model.bodies?.some((part) => part.id === owner)) command.body = owner;
      }
    }
  } else if (command.type === 'cylinder_edit') {
    if (![command.height, command.radius].every((value) => Number.isFinite(value) && value >= minimumCadDimension)) return null;
  } else if (command.type === 'delete_body') {
    if (!model.bodies?.some((part) => part.id === command.body)) return null;
  } else return null;
  operations.push(command);
  return {...documentState, operations};
}

function clearDirectPreview() {
  previewGeneration++;
  previewPending = null;
  previewKey = '';
  clearTimeout(previewTimer);
  previewTimer = null;
  viewport?.setPreview(null);
}

function scheduleDirectPreview() {
  if (previewInFlight || previewTimer !== null || !previewPending) return;
  const delay = Math.max(0, previewInterval - (performance.now() - previewStartedAt));
  previewTimer = setTimeout(updateDirectPreview, delay);
}

async function updateDirectPreview() {
  previewTimer = null;
  const pending = previewPending;
  if (!pending) return;
  previewPending = null;
  previewInFlight = true;
  previewStartedAt = performance.now();
  const generation = previewGeneration;
  try {
    const result = await (await responseFor('/api/cad/model', pending)).json();
    if (generation === previewGeneration) viewport?.setPreview(result);
  } catch {
    if (generation === previewGeneration) viewport?.setPreview(null);
  } finally {
    previewInFlight = false;
    scheduleDirectPreview();
  }
}

function onDirectPreview(operation) {
  if (!operation || busy || !ready || activeSketchId) return clearDirectPreview();
  const key = JSON.stringify(operation);
  if (key === previewKey) return;
  const next = directDocument(operation);
  if (!next) return clearDirectPreview();
  previewKey = key;
  previewPending = next;
  scheduleDirectPreview();
}

function onDirectCommit(operation) {
  clearDirectPreview();
  if (busy || !ready || activeSketchId) return false;
  const next = directDocument(operation);
  return next ? changeDocument(next, 'edit', {id: null, tool: 'select'}) : true;
}

function onSketchPull(sketchId, regionId, distance, bodyId, mode = pullMode) {
  return onDirectCommit({type: 'pull', sketch: sketchId, region: regionId, distance, body: bodyId || undefined, mode});
}

function onFillet(edge, radius, bodyId) {
  return onDirectCommit({type: 'fillet', edge, radius, body: bodyId || undefined});
}

function dimensionField(key, label, value, min = null) {
  return {key, label: `${label} (mm)`, value, min};
}

function channelDimension(sketchId, channel, arcId = null) {
  const operation = documentState.operations[sketchOperationIndex(sketchId)];
  const arc = operation?.entities.find((entity) => entity.id === arcId && entity.kind === 'arc');
  const inputs = [dimensionField('width', '전체 폭', channel.width, minimumCadDimension)];
  if (arc) inputs.push(dimensionField('radius', '중심선 턴 반지름', arc.radius, minimumCadDimension));
  return {
    title: '유로 치수',
    inputs,
    apply(values) {
      const current = documentState.operations[sketchOperationIndex(sketchId)];
      const definition = editableChannels(current).find((item) => item.id === channel.id);
      if (!definition) return false;
      const width = values.width === displayedDimension(channel.width) ? channel.width : values.width;
      const radiusEdited = arc && values.radius !== displayedDimension(arc.radius);
      if (width === definition.width && !radiusEdited) return true;
      try {
        const next = reflowChannel(current, definition, width, radiusEdited ? arc.id : null, {radius: values.radius});
        return changeSketchOperation(sketchId, next, {tool: 'select', channel: channel.id});
      } catch (error) {
        showMessage(error.message);
        return false;
      }
    },
  };
}

function sketchDimension(target) {
  const operation = documentState.operations.find((op) => op.type === 'sketch' && op.id === target.sketchId);
  const entity = operation?.entities.find((item) => item.id === target.entityId);
  if (!entity) return null;
  const channel = channelForEntity(operation, entity.id);
  if (channel) {
    const arcId = channel.centerlineIds.includes(entity.id) ? entity.id :
      channel.outlineSources[channel.outlineIds.indexOf(entity.id)];
    selectChannel(channel.id);
    return channelDimension(target.sketchId, channel, arcId);
  }
  const length = entity.kind === 'line' ? Math.hypot(entity.x2 - entity.x1, entity.y2 - entity.y1) : 0;
  const positive = 0.000001;
  const byKind = {
    point: [dimensionField('x', 'X 위치', entity.x), dimensionField('y', 'Y 위치', entity.y)],
    line: [dimensionField('length', '길이', length, positive)],
    rectangle: [dimensionField('width', 'X 길이', entity.width, positive), dimensionField('length', 'Y 길이', entity.length, positive)],
    circle: [dimensionField('radius', '반지름', entity.radius, positive)],
    ellipse: [dimensionField('rx', 'X 반지름', entity.rx, positive), dimensionField('ry', 'Y 반지름', entity.ry, positive)],
    arc: [dimensionField('radius', '반지름', entity.radius, minimumCadDimension)],
    ellipseArc: [dimensionField('rx', 'X 반지름', entity.rx, positive), dimensionField('ry', 'Y 반지름', entity.ry, positive)],
  };
  return {
    title: `${sketchLabels[entity.kind]} 치수`,
    inputs: byKind[entity.kind],
    apply(values) {
      if (entity.kind === 'line') {
        const scale = values.length / length;
        values = {x2: entity.x1 + (entity.x2 - entity.x1) * scale, y2: entity.y1 + (entity.y2 - entity.y1) * scale};
      }
      return onSketchEdit(target.sketchId, target.entityId, values);
    },
  };
}

function filletDimension(element) {
  const index = element.fillet_index;
  const previous = Number.isInteger(index) ? documentState.operations[index] : null;
  if (previous?.type !== 'fillet' && !element.ref) return null;
  return {
    title: '모서리 필렛',
    inputs: [dimensionField('radius', '필렛 반지름', previous?.radius ?? '', previous ? 0 : 0.000001)],
    apply({radius}) { return onDirectCommit({type: 'fillet', body: element.body_id, edge: element.ref, radius, index}); },
  };
}

function planeFaceDimension(face) {
  const {origin, x, y} = face.plane;
  const normal = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const offset = origin.reduce((sum, value, index) => sum + value * normal[index], 0);
  const bounds = model.bodies?.find((part) => part.id === face.body_id)?.bounds;
  const axis = normal.findIndex((component) => Math.abs(component) > 1 - 1e-10);
  if (bounds && axis >= 0) {
    const endpoint = bounds[axis + (normal[axis] > 0 ? 3 : 0)];
    if (Math.abs(origin[axis] - endpoint) < 1e-6) {
      const size = bounds[axis + 3] - bounds[axis];
      return {input: dimensionField('length', `${'XYZ'[axis]} 길이`, size, 0.000001), distance: (value) => value - size};
    }
  }
  return {input: dimensionField('offset', '면 위치 · 법선', offset), distance: (value) => value - offset};
}

function faceDimension(face) {
  if (Number.isInteger(face.fillet_index)) return filletDimension(face);
  if (!face.ref || !face.body_id) return null;
  if (Number.isFinite(face.cylinder?.height) && Number.isFinite(face.cylinder.radius)) {
    const {height, radius} = face.cylinder;
    return cylinderDimension(height, radius, (values) => onDirectCommit({
      type: 'cylinder_edit', body: face.body_id, face: face.ref, ...values,
    }));
  }
  let spec;
  if (face.surface?.kind === 'cylinder') {
    const {radius, sense} = face.surface;
    spec = {input: dimensionField('radius', '원통 반지름', radius, 0.000001), distance: (value) => (value - radius) * (sense ?? 1)};
  } else if (face.plane) {
    spec = planeFaceDimension(face);
  } else return null;
  return {
    title: '면 치수',
    inputs: [spec.input],
    apply(values) {
      return onDirectCommit({type: 'face_edit', body: face.body_id, face: face.ref, distance: spec.distance(values[spec.input.key])});
    },
  };
}

function cylinderDimension(height, radius, apply) {
  return {
    title: '원통 치수',
    inputs: [dimensionField('height', '높이', height, minimumCadDimension),
      dimensionField('radius', '반지름', radius, minimumCadDimension)],
    apply(values) {
      const nextHeight = values.height === displayedDimension(height) ? height : values.height;
      const nextRadius = values.radius === displayedDimension(radius) ? radius : values.radius;
      if (nextHeight === height && nextRadius === radius) return true;
      return apply({height: nextHeight, radius: nextRadius});
    },
  };
}

function displayedDimension(value) {
  return Number.isFinite(value) ? Number(value.toFixed(9)) : value;
}

function dimensionInput(field) {
  const label = document.createElement('label');
  label.className = 'field';
  const caption = document.createElement('span');
  caption.textContent = field.label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.name = field.key;
  input.required = true;
  input.value = displayedDimension(field.value);
  if (field.min !== null) input.min = field.min;
  label.append(caption, input);
  return label;
}

function openDimensionEditor(spec, [screenX, screenY]) {
  dimensionEdit = spec;
  const editor = byId('dimension-editor');
  byId('dimension-title').textContent = spec.title;
  byId('dimension-fields').replaceChildren(...spec.inputs.map(dimensionInput));
  editor.hidden = false;
  const rect = byId('viewport').getBoundingClientRect();
  editor.style.left = `${Math.max(8, Math.min(screenX - rect.left + 14, rect.width - editor.offsetWidth - 8))}px`;
  editor.style.top = `${Math.max(8, Math.min(screenY - rect.top + 14, rect.height - editor.offsetHeight - 8))}px`;
  const first = editor.querySelector('input');
  first.focus({preventScroll: true});
  first.select();
}

function onDimensionPick(target) {
  if (!target || !ready || busy) return;
  if (Boolean(activeSketchId) !== (target.kind === 'sketch')) return;
  const spec = target.kind === 'sketch' ? sketchDimension(target)
    : target.kind === 'face' ? faceDimension(target.face) : filletDimension(target.edge);
  if (spec) openDimensionEditor(spec, target.at);
}

function closeDimensionEditor(focusCanvas = false) {
  if (!dimensionEdit) return;
  dimensionEdit = null;
  byId('dimension-editor').hidden = true;
  if (focusCanvas) byId('cad-canvas').focus({preventScroll: true});
}

function updateProfile() {
  const profile = byId('profile').value;
  const isProfileTool = tool === 'extrude' || tool === 'cut';
  for (const label of document.querySelectorAll('[data-profile]')) {
    const visible = label.dataset.profile === profile;
    label.hidden = !visible;
    label.querySelector('input').disabled = !visible || !isProfileTool;
  }
  for (const id of ['tool-rectangle', 'tool-circle']) {
    byId(id).setAttribute('aria-pressed', String(drawing && profile === id.replace('tool-', '')));
  }
  byId('profile-fields').hidden = !isProfileTool;
}

function setActiveView(view) {
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  byId('view-plan').setAttribute('aria-pressed', String(view === 'plane'));
}

function renderGestureControls() {
  byId('viewport').dataset.drawing = String(drawing || !['select', 'move'].includes(sketchTool));
  byId('draw-profile').setAttribute('aria-pressed', String(drawing));
  byId('draw-profile').textContent = drawing ? '그리기 종료' : '화면에서 그리기';
  const cut = tool === 'cut';
  byId('drag-depth').setAttribute('aria-pressed', String(depthActive));
  byId('drag-depth').textContent = depthActive ? '드래그 종료' : cut ? '깊이 드래그' : '높이 드래그';
  let note = '가운데 버튼 회전 · Shift + 가운데 버튼 이동 · 휠 확대';
  if (activeSketchId) note = '가운데 버튼 이동 · 휠 확대 · Ctrl + ←/→ 작업 평면 이동';
  if (drawing) note = '왼쪽 버튼을 누르고 끌어서 스케치를 그리세요.';
  if (depthActive) note = cut ? '핸들을 끌어 절삭 깊이를 정하고 놓으면 적용됩니다.' : '핸들을 끌어 돌출 높이를 정하고 놓으면 적용됩니다.';
  byId('scene-note').textContent = note;
  renderModelInfo();
}

function changeDrawing(value) {
  const plane = fields.z.valueAsNumber;
  drawing = Boolean(value && viewport && Number.isFinite(plane));
  if (drawing && depthActive) changeDepth(false);
  if (drawing) setActiveView('top');
  viewport?.setSketch(drawing ? {planeZ: plane, profile: byId('profile').value} : null);
  updateProfile();
  renderGestureControls();
}

function onSketch(shape) {
  for (const dimension of ['x', 'y', 'width', 'length', 'radius']) {
    if (Number.isFinite(shape[dimension])) fields[dimension].value = Number(shape[dimension].toFixed(5));
  }
  changeDrawing(false);
  changeDepth(true);
  byId('feature-apply').focus({preventScroll: true});
}

function depthOperation() {
  if (tool !== 'extrude' && tool !== 'cut') return null;
  const operation = readOperation();
  const valid = Object.keys(operation).every((key) => !fields[key] || fields[key].validity.valid);
  return valid ? operation : null;
}

function changeDepth(value, report = false) {
  if (value) {
    if (!viewport || !ready || busy || (tool === 'cut' && !model.part)) return;
    const operation = depthOperation();
    if (!operation) {
      if (report) byId('operation-form').reportValidity();
      return;
    }
    if (drawing) changeDrawing(false);
    depthActive = true;
    viewport.setDepthTool(operation);
  } else {
    depthActive = false;
    onDepthCancel();
    viewport?.setDepthTool(null);
  }
  renderGestureControls();
}

function refreshDepth() {
  if (depthActive) viewport?.setDepthTool(depthOperation());
}

function onDepthChange(height) {
  if (!depthActive || !Number.isFinite(height)) return;
  originalDepthHeight ??= fields.height.value;
  fields.height.value = height;
}

function onDepthCancel(height) {
  if (originalDepthHeight !== null || Number.isFinite(height)) {
    fields.height.value = originalDepthHeight ?? height;
  }
  originalDepthHeight = null;
}

function onDepthCommit(height) {
  if (!depthActive || busy || !Number.isFinite(height)) return;
  fields.height.value = height;
  originalDepthHeight = null;
  byId('operation-form').requestSubmit();
}

function renderInspector() {
  const feature = documentState.operations[editIndex];
  const isProfileTool = tool === 'extrude' || tool === 'cut';
  const isMove = tool === 'move';
  const isImport = tool === 'import';
  byId('operation-heading').textContent = editIndex === null ? toolInfo[tool].heading : `${featureTitle(feature)} 편집`;
  byId('operation-description').textContent = isMove && moveBodyId
    ? '선택한 부품을 X, Y, Z 방향으로 지정 거리만큼 이동합니다.' : toolInfo[tool].description;
  byId('feature-type').value = tool;
  byId('height-label').textContent = tool === 'cut' ? '절삭 깊이' : '돌출 높이';
  byId('move-fields').hidden = !isMove;
  for (const key of ['dx', 'dy', 'dz']) fields[key].disabled = !isMove;
  for (const key of ['x', 'y', 'z', 'height']) fields[key].disabled = !isProfileTool;
  byId('profile').disabled = !isProfileTool;
  byId('import-detail').hidden = !isImport;
  byId('import-detail').textContent = isImport ? feature.name : '';
  byId('feature-apply').hidden = isImport;
  byId('feature-apply').textContent = editIndex === null ? toolInfo[tool].submit || '적용' : '변경 적용';
  byId('cancel-edit').hidden = editIndex === null;
  byId('make-domain').hidden = editIndex === null || tool !== 'cut';
  byId('make-domain').textContent = documentState.domainCut === editIndex && editIndex !== null
    ? '이 절삭을 유체 체적으로 사용 중'
    : '이 절삭으로 유체 체적 만들기';
  byId('make-domain').disabled = documentState.domainCut === editIndex;
  byId('draw-profile').disabled = !viewport;
  byId('use-face').disabled = !Number.isFinite(selectedFace?.plane_z);
  for (const name of ['extrude', 'cut', 'move']) {
    byId(`tool-${name}`).setAttribute('aria-pressed', String(tool === name));
  }
  updateProfile();
  renderGestureControls();
  enableModelTools();
}

function defaultPlane() {
  return Number.isFinite(selectedFace?.plane_z) ? selectedFace.plane_z : model.part?.bounds[5] ?? 0;
}

function setTool(name, options = {}) {
  const previousTool = tool;
  const wasEditing = editIndex !== null;
  if (depthActive) changeDepth(false);
  tool = name;
  moveBodyId = name === 'move' ? options.body ?? null : null;
  editIndex = null;
  if (options.profile) byId('profile').value = options.profile;
  if (previousTool !== name || wasEditing || options.reset) {
    fields.z.value = Number(defaultPlane().toFixed(7));
    fields.height.value = name === 'cut' ? 2 : 6;
    for (const key of ['dx', 'dy', 'dz']) fields[key].value = 0;
  }
  changeDrawing(options.draw ?? false);
  renderInspector();
  renderFeatures();
  enableModelTools();
}

function editFeature(index) {
  const operation = documentState.operations[index];
  if (!operation || operation.type === 'delete_body' || busy) return;
  closeDimensionEditor();
  if (depthActive) changeDepth(false);
  changeDrawing(false);
  if (operation.type === 'sketch') {
    editIndex = null;
    directEditIndex = null;
    byId('direct-form').hidden = true;
    byId('legacy-operations').open = false;
    setSketchInteraction(operation.id);
    renderSketchWorkspace();
    return;
  }
  if (operation.type === 'cylinder_edit') {
    editIndex = null;
    directEditIndex = index;
    setSketchInteraction(null);
    byId('direct-form').hidden = true;
    byId('legacy-operations').open = false;
    renderSketchWorkspace();
    const spec = cylinderDimension(operation.height, operation.radius, (values) => {
      const operations = documentState.operations.slice();
      operations[index] = {...operation, ...values};
      return changeDocument({...documentState, operations}, 'edit', {id: null});
    });
    const rect = byId('viewport').getBoundingClientRect();
    openDimensionEditor(spec, [rect.left + rect.width / 2, rect.top + rect.height / 3]);
    return;
  }
  if (['pull', 'fillet', 'face_edit'].includes(operation.type)) {
    editIndex = null;
    directEditIndex = index;
    setSketchInteraction(null);
    byId('legacy-operations').open = false;
    const fillet = operation.type === 'fillet';
    const value = byId('direct-value');
    byId('direct-value-label').textContent = fillet ? '필렛 반지름 (mm)' : '면 이동 거리 (mm)';
    value.value = fillet ? operation.radius : operation.distance;
    value.min = fillet ? '0' : '';
    byId('direct-form').hidden = false;
    const domain = byId('make-direct-domain');
    const isDomain = documentState.domainCut === index;
    domain.hidden = !isPullCut(operation);
    domain.textContent = isDomain ? '선택된 유체 체적' : '이 절삭으로 유체 체적 만들기';
    renderSketchWorkspace();
    return;
  }
  setSketchInteraction(null);
  directEditIndex = null;
  byId('direct-form').hidden = true;
  byId('legacy-operations').open = true;
  renderSketchWorkspace();
  editIndex = index;
  tool = operation.type;
  moveBodyId = tool === 'move' ? operation.body ?? null : null;
  if (operation.profile) byId('profile').value = operation.profile;
  for (const [key, field] of Object.entries(fields)) {
    if (Number.isFinite(operation[key])) field.value = operation[key];
  }
  renderInspector();
  renderFeatures();
  enableModelTools();
}

function restoreModel(state, geometry, interaction) {
  const firstPart = !model.part && geometry.part;
  const firstDomain = !model.domain && geometry.domain;
  documentState = {...state, operations: state.operations.map((operation, index) => {
    if (operation.type === 'sketch' && !Object.hasOwn(operation, 'channels')) {
      const channels = recoverSketchChannels(operation.entities);
      if (channels.length) return {...operation, channels};
    }
    if (operation.type !== 'fillet' || !operation.radius) return operation;
    const corner = geometry.filletCorners?.[index];
    if (corner) return {...operation, edgeCorner: corner};
    const {edgeCorner, ...unchanged} = operation;
    return unchanged;
  })};
  model = geometry;
  byId('project-name').value = state.projectName || '';
  invalidFeatureIndex = null;
  selectedSketchEntity = null;
  if (interaction) {
    setSketchInteraction(interaction.id, interaction.tool);
    if (Object.hasOwn(interaction, 'region')) activeSketchRegion = interaction.region;
    if (Object.hasOwn(interaction, 'channel')) channelSelection = interaction.channel;
    if (interaction.entity) selectedSketchEntity = interaction.entity;
  } else if (!draftSketch && !geometry.sketches?.some((sketch) => sketch.id === activeSketchId)) {
    setSketchInteraction(null);
  }
  directEditIndex = null;
  byId('direct-form').hidden = true;
  viewport?.setModel(model);
  renderCaps();
  updateSection();
  if (firstPart) {
    viewport?.setView('iso');
    viewport?.fit();
    setActiveView('iso');
  }
  if (firstDomain) byId('view-layer').value = 'both';
  viewport?.setFocus(model.domain ? byId('view-layer').value : 'part');
  onPick(null);
  saveLocally(documentState);
  renderModelInfo();
  setTool('extrude', {reset: true});
  renderSketchWorkspace();
}

async function changeDocument(next, action = 'edit', interaction = null) {
  if (busy || !ready) return false;
  clearDirectPreview();
  setBusy(true);
  showMessage('');
  let success = false;
  try {
    const response = await responseFor('/api/cad/model', next);
    const geometry = await response.json();
    if (action === 'undo') {
      past = past.slice(0, -1);
      future = [...future, documentState];
    } else if (action === 'redo') {
      past = [...past, documentState].slice(-historyLimit);
      future = future.slice(0, -1);
    } else if (action === 'edit') {
      past = [...past, documentState].slice(-historyLimit);
      future = [];
    }
    restoreModel(next, geometry, interaction);
    success = true;
  } catch (error) {
    invalidFeatureIndex = Number.isInteger(error.operationIndex) ? error.operationIndex : null;
    renderFeatures();
    showMessage(error.message);
  } finally {
    setBusy(false);
  }
  return success;
}

function readOperation() {
  if (tool === 'move') return {type: tool, body: moveBodyId ?? undefined, ...readFields(['dx', 'dy', 'dz'])};
  const profile = byId('profile').value;
  const dimensions = profile === 'rectangle' ? ['width', 'length'] : ['radius'];
  return {type: tool, profile, ...readFields(['x', 'y', 'z', 'height', ...dimensions])};
}

function readFields(keys) {
  return Object.fromEntries(keys.map((key) => [key, fields[key].valueAsNumber]));
}

async function applyFeature(event) {
  event.preventDefault();
  if (tool === 'import' || busy || !ready) return;
  const operation = readOperation();
  const operations = documentState.operations.slice();
  if (editIndex === null) operations.push(operation);
  else operations[editIndex] = operation;
  if (await changeDocument({...documentState, operations})) {
    setTool(operation.type, {profile: operation.profile, reset: true});
  }
}

function withFile(input, handler) {
  input.addEventListener('change', async () => {
    const [file] = input.files;
    input.value = '';
    if (!file || busy || !ready) return;
    try {
      await handler(file);
    } catch (error) {
      showMessage(error.message);
    }
  });
}

function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result.split(',')[1]));
    reader.addEventListener('error', () => reject(new Error('파일을 읽을 수 없습니다.')));
    reader.readAsDataURL(file);
  });
}

async function importStep(file) {
  if (!/\.(step|stp)$/i.test(file.name)) throw new Error('STEP 파일(.step 또는 .stp)을 선택하세요.');
  if (file.size > stepSizeLimit) throw new Error('4 MiB 이내의 STEP 파일을 선택하세요.');
  const operation = {type: 'import', name: file.name, step: await encodeFile(file)};
  return changeDocument({...emptyDocument(), operations: [operation]}, 'edit', {id: null});
}

async function readProject(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error('CAD 작업 파일이 너무 큽니다.');
  let state;
  try { state = JSON.parse(await file.text()); }
  catch { throw new Error('CAD 작업 파일의 JSON을 읽을 수 없습니다.'); }
  if (state?.version !== 1 || !Array.isArray(state.operations)) {
    throw new Error('이 앱에서 저장한 CAD 작업 파일을 선택하세요.');
  }
  return changeDocument(removeEmptySketches(state), 'edit', {id: null});
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportStep(target) {
  if (busy || !ready) return;
  setBusy(true);
  showMessage('');
  try {
    const response = await responseFor(`/api/cad/export/${target}.step`, documentState);
    download(await response.blob(), target === 'part' ? 'part.step' : 'fluid-domain.step');
  } catch (error) {
    showMessage(error.message);
  } finally {
    setBusy(false);
  }
}

function moveInHistory(direction) {
  const next = (direction === 'undo' ? past : future).at(-1);
  if (next) changeDocument(next, direction);
}

byId('operation-form').addEventListener('submit', applyFeature);
byId('new-sketch-xy').onclick = () => {
  const reference = referencePlaneOf(currentSketch()) ?? preferredReferencePlane;
  document.querySelector(`[data-sketch-plane="${reference}"]`)?.focus();
};
byId('new-sketch-face').onclick = () => startSketch(selectedSketchPlane(), 'select', selectedFace?.body_id, selectedFace?.ref);
byId('sketch-mode').onclick = () => openSketchFromShortcut();
byId('activate-pull').onclick = activatePull;
for (const button of document.querySelectorAll('[data-sketch-plane]')) {
  button.onclick = () => startReferenceSketch(button.dataset.sketchPlane);
}
byId('finish-sketch').onclick = finishSketch;
for (const button of document.querySelectorAll('[data-sketch-tool]')) {
  button.onclick = () => chooseSketchTool(button.dataset.sketchTool);
}
for (const name of ['extrude', 'cut', 'move']) {
  byId(`tool-${name}`).onclick = () => {
    finishSketch();
    setTool(name);
  };
}
for (const profile of ['rectangle', 'circle']) {
  byId(`tool-${profile}`).onclick = () => {
    finishSketch();
    setTool(tool === 'cut' ? 'cut' : 'extrude', {profile, draw: true});
  };
}
byId('profile').onchange = () => {
  changeDrawing(drawing);
  refreshDepth();
};
fields.z.onchange = () => { if (drawing) changeDrawing(true); };
for (const key of ['x', 'y', 'z', 'width', 'length', 'radius', 'height']) {
  fields[key].addEventListener('input', refreshDepth);
}
byId('draw-profile').onclick = () => {
  if (activeSketchId) finishSketch();
  changeDrawing(!drawing);
};
byId('drag-depth').onclick = () => {
  if (activeSketchId) finishSketch();
  changeDepth(!depthActive, true);
};
byId('snap-toggle').onclick = () => {
  snapEnabled = !snapEnabled;
  byId('snap-toggle').setAttribute('aria-pressed', String(snapEnabled));
  viewport?.setSnap(snapEnabled);
};
byId('use-face').onclick = () => {
  if (!Number.isFinite(selectedFace?.plane_z)) return;
  fields.z.value = Number(selectedFace.plane_z.toFixed(7));
  if (drawing) changeDrawing(true);
  refreshDepth();
};
byId('cancel-edit').onclick = () => setTool('extrude', {reset: true});
byId('make-domain').onclick = async () => {
  const index = editIndex;
  if (await changeDocument({...documentState, domainPorts:null, domainCut: index})) editFeature(index);
};
byId('direct-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const index = directEditIndex;
  const op = documentState.operations[index];
  if (!op || busy) return;
  const value = byId('direct-value').valueAsNumber;
  const fillet = op.type === 'fillet';
  if (!Number.isFinite(value) || (fillet ? value < 0 : value === 0)) {
    showMessage(fillet ? '0 이상의 반지름을 입력하세요.' : '0이 아닌 이동 거리를 입력하세요.');
    return;
  }
  const operations = documentState.operations.slice();
  operations[index] = {...op, [fillet ? 'radius' : 'distance']: value};
  if (await changeDocument({...documentState, operations}, 'edit', {id: null})) editFeature(index);
});
byId('dimension-editor').addEventListener('submit', async (event) => {
  event.preventDefault();
  const spec = dimensionEdit;
  if (!spec || busy) return;
  const values = Object.fromEntries(Array.from(byId('dimension-fields').querySelectorAll('input'),
    (input) => [input.name, input.valueAsNumber]));
  if (await spec.apply(values)) closeDimensionEditor(true);
});
byId('dimension-cancel').onclick = () => closeDimensionEditor(true);
byId('pull-mode').onchange = (event) => {
  pullMode = event.target.value;
  clearDirectPreview();
  syncSketchViewport();
};
byId('merge-sketch-overlaps').onclick = () => mergeSketchOverlaps();
byId('delete-element').onclick = () => deleteSelectedElement();
byId('make-direct-domain').onclick = async () => {
  const index = directEditIndex;
  if (index !== null && await changeDocument({...documentState, domainPorts:null, domainCut: index}, 'edit', {id: null})) editFeature(index);
};
function renderCaps() {
  const panel = byId('port-extractor'), list = byId('cap-list');
  const caps = model.openings || [];
  panel.hidden = !documentState.operations.some(op => op.type === 'import');
  list.replaceChildren();
  for (const [i, cap] of caps.entries()) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = cap.ref;
    input.checked = Boolean(documentState.domainPorts?.includes(cap.ref));
    const centre = cap.bounds.slice(0,3).map((x,k) => formatNumber((x + cap.bounds[k+3])/2));
    label.append(input, ' 포트 ' + (i+1) + ' · (' + centre.join(', ') + ') mm');
    list.append(label);
  }
  byId('cap-warning').textContent = model.domainWarning || (caps.length ? '' : '평면에서 닫힌 개구부를 찾지 못했습니다.');
  syncCaps();
}
function syncCaps() {
  const choices = Array.from(byId('cap-list').querySelectorAll('input'));
  byId('extract-caps').disabled = !choices.some(x => x.checked);
  viewport?.setPortPicker(byId('port-extractor').open ? model.openings || [] : [], choices.filter(x => x.checked).map(x => x.value), ref => {
    const item = choices.find(x => x.value === ref);
    if (item) {item.checked = !item.checked; syncCaps();}
  });
}
byId('port-extractor').ontoggle = syncCaps;
byId('cap-list').onchange = syncCaps;
byId('extract-caps').onclick = async () => {
  const domainPorts = Array.from(byId('cap-list').querySelectorAll('input:checked'), item => item.value);
  if (await changeDocument({...documentState, domainCut:null, domainPorts})) byId('port-extractor').open = false;
};
byId('clear-domain').onclick = () => changeDocument({...documentState, domainPorts:null, domainCut: null});
byId('project-name').onchange = event => changeDocument({...documentState,projectName:event.target.value.trim()});
byId('new-project').onclick = () => changeDocument(emptyDocument(), 'edit', {id: null});
byId('import-step').onclick = () => byId('step-file').click();
byId('open-project').onclick = () => byId('project-file').click();
byId('save-project').onclick = () => download(new Blob([JSON.stringify(documentState, null, 2)], {type: 'application/json'}), 'part.cad.json');
byId('export-part').onclick = () => exportStep('part');
byId('export-domain').onclick = () => exportStep('domain');
byId('open-flow').onclick = () => {
  if (saveLocally(documentState)) location.assign('/flow');
  else showMessage('이 브라우저의 저장 공간에 모델을 넘길 수 없습니다. CAD 프로젝트를 저장하고 유동해석 화면에서 열어 주세요.');
};
byId('undo').onclick = () => moveInHistory('undo');
byId('redo').onclick = () => moveInHistory('redo');
byId('view-fit').onclick = () => viewport?.fit();
byId('view-plan').onclick = showSketchPlan;
byId('view-origin').onclick = () => viewport?.goToOrigin();
byId('view-layer').onchange = (event) => viewport?.setFocus(event.target.value);
function updateSection() {
  const button = byId('inspect-section');
  const bounds = [model?.part?.bounds, model?.domain?.bounds].filter(Boolean);
  button.disabled = !bounds.length;
  if (!bounds.length) button.setAttribute('aria-pressed', 'false');
  const active = button.getAttribute('aria-pressed') === 'true';
  byId('section-controls').hidden = !active;
  if (!active) { viewport?.setSection(-1, 0); return; }
  const axis = byId('cut-axis').selectedIndex;
  const low = Math.min(...bounds.map(b => b[axis]));
  const high = Math.max(...bounds.map(b => b[axis+3]));
  const coordinate = low + (high-low) * byId('cut-fraction').valueAsNumber / 1000;
  byId('cut-location').textContent = byId('cut-axis').value + ' = ' + formatNumber(coordinate) + ' mm';
  viewport?.setSection(axis, coordinate);
}
byId('inspect-section').onclick = event => {
  const button = event.currentTarget;
  button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
  updateSection();
};
byId('cut-axis').onchange = updateSection;
byId('cut-fraction').oninput = updateSection;
withFile(byId('step-file'), importStep);
withFile(byId('project-file'), readProject);

for (const button of document.querySelectorAll('[data-view]')) {
  button.onclick = () => {
    if (activeSketchId) return;
    if (drawing) changeDrawing(false);
    if (depthActive && button.dataset.view === 'top') changeDepth(false);
    setActiveView(button.dataset.view);
    viewport?.setView(button.dataset.view);
  };
}

const sketchShortcuts = {
  KeyL: () => openSketchFromShortcut('line'),
  KeyR: () => openSketchFromShortcut('rectangle'),
  KeyC: () => openSketchFromShortcut('circle'),
  KeyT: () => openSketchFromShortcut('trim'),
  KeyS: () => activeSketchId ? chooseSketchTool('select') : returnToModeling(),
  KeyK: () => openSketchFromShortcut(),
  KeyD: returnToModeling,
  KeyV: showSketchPlan,
  KeyP: activatePull,
  KeyM: activateMove,
};

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || event.key === 'Process') return;
  const input = event.target instanceof HTMLElement &&
    (event.target.matches('input, textarea, select') || event.target.isContentEditable);
  if (event.key === 'Escape') {
    if (dimensionEdit) {
      event.preventDefault();
      closeDimensionEditor(true);
      return;
    }
    if (input) return;
    if (drawing) changeDrawing(false);
    if (depthActive) changeDepth(false);
    if (sketchTool !== 'select') chooseSketchTool('select');
    if (selectedSketchEntity || activeSketchRegion || selectedTreeNode) onSketchSelect(null);
    return;
  }
  if (input) return;
  if (event.key === 'Delete' && !byId('delete-element').disabled) {
    event.preventDefault();
    if (!event.repeat) deleteSelectedElement();
    return;
  }
  if (event.key === 'F2' && selectedTreeNode) {
    event.preventDefault();
    if (!event.repeat) renameSelectedTreeNode();
    return;
  }
  const code = event.code || (event.key.length === 1 ? `Key${event.key.toUpperCase()}` : event.key);
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (code === 'KeyZ' || (code === 'KeyY' && !event.shiftKey))) {
    event.preventDefault();
    if (!event.repeat) moveInHistory(code === 'KeyY' || event.shiftKey ? 'redo' : 'undo');
    return;
  }
  if (!ready || busy || !viewport) return;
  if (activeSketchId && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    if (!event.repeat) shiftSketchGrid(event.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
  if (!Object.hasOwn(sketchShortcuts, code)) return;
  const keepMoveInput = code === 'KeyM' && !activeSketchId;
  if (sketchShortcuts[code]() === false) return;
  event.preventDefault();
  if (!keepMoveInput) byId('cad-canvas').focus({preventScroll: true});
});

async function initialize() {
  try {
    viewport = createViewport(byId('cad-canvas'), {
      onPick, onSketch, onDepthChange, onDepthCancel, onDepthCommit,
      onSketchCreate, onSketchEdit, previewSketchEdit, onSketchMove, onSketchPull, onSketchSelect, onSketchToolPick, onFillet,
      onDirectPreview, onDirectCommit, onDimensionPick,
      onChange: ({view}) => setActiveView(view),
    });
  } catch {
    showMessage('3D 화면을 열 수 없습니다. 브라우저의 WebGL 설정을 확인하세요.');
  }
  renderInspector();
  renderSketchWorkspace();
  try {
    const status = await (await responseFor('/api/cad/status')).json();
    const badge = byId('cad-status');
    ready = status.ready;
    badge.textContent = ready ? (status.kernel || 'CAD 커널 준비됨') : 'CAD 커널 미설치';
    badge.dataset.tone = ready ? 'ok' : 'error';
    if (!ready) {
      showMessage(status.message || 'CAD 커널 설치 방법은 README를 확인하세요.');
    } else {
      let saved;
      try { saved = JSON.parse(localStorage.getItem(autosaveKey)); }
      catch { /* A blank workbench remains available. */ }
      if (saved?.version === 1 && Array.isArray(saved.operations) && saved.operations.length) {
        await changeDocument(removeEmptySketches(saved), 'restore');
      }
    }
  } catch (error) {
    byId('cad-status').textContent = '커널 상태 확인 실패';
    byId('cad-status').dataset.tone = 'error';
    showMessage(error.message);
  }
  enableModelTools();
}

initialize();


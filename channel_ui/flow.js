import {createViewport} from '/cad-view.js';
import {createContourPanel} from '/contour-view.js';

const byId = (id) => document.getElementById(id);
const stages = [...document.querySelectorAll('#flow-stages li')];
const ports = {inlet: byId('inlet-face'), outlet: byId('outlet-face')};
const portColors = {inlet: [.44, .73, 1, 1], outlet: [1, .71, .42, 1]};
const gridColors = {...portColors, walls: [.63, .72, .81, 1], section: [.34, .8, .69, 1]};
const sectionAxes = ['x', 'y', 'z'];
const sectionViews = {x: 'right', y: 'front', z: 'top'};
const roleLabels = {inlet: '입구', outlet: '출구'};
const faceHelp = '목록에서도 면을 고를 수 있습니다. 가운데 버튼으로 회전하고 휠로 확대합니다.';
const fluidValues = {air: [1.204, 0.00001825], water: [998.2, 0.001002], hydrogen: [0.0838, 0.0000088]};
const states = {
  queued: ['대기', ''], running: ['실행 중', 'active'],
  complete: ['완료', 'success'], failed: ['실패', 'error'], stopped:['중지','warning'],
};
const logForStage = {
  prepare: 'log.prepare', mesh: 'log.gmsh', convert: 'log.gmshToFoam',
  checkMesh: 'log.checkMesh', foamRun: 'log.foamRun', postprocess: 'log.postprocess',
};
const numberFormat = new Intl.NumberFormat('ko-KR', {maximumSignificantDigits: 6});
const runPath = '/api/flow/runs';
const projectKey = 'openfoam-cad-project-v1';
let chosen = new URL(location.href).searchParams.get('run');
let shownRun;
let pollId;
let pendingMeshPreview;
const inletUnits = {
  speed: {'m/s': 1, 'cm/s': 0.01, 'mm/s': 0.001},
  flow: {'mL/min': 1, 'L/min': 1000, 'mL/s': 60, 'm³/s': 6e7},
};
let refreshVersion = 0;
let domainVersion = 0;
let submitting = false;
let viewport;
let documentState;
let planarFaces = new Map();
let environment;
let logKey = '';
let logVersion = 0;
let historyKey = '';
let resultKey = '';
let activePort = 'inlet';
let meshViewport;
let meshRunId;
let meshBounds;
let previewAbort;
let previewTimer;
let solveSource;
const meshSurfaceCache = new Map();

function format(value, unit = '') {
  return Number.isFinite(value) ? numberFormat.format(value) + (unit ? ' ' + unit : '') : '—';
}

function notice(id, message) {
  const node = byId(id);
  if (node.textContent !== message) node.textContent = message;
  node.hidden = !message;
}

function badge(node, label, tone = '') {
  if (node.textContent !== label) node.textContent = label;
  node.dataset.tone = tone;
}

function description(term, value) {
  const wrapper = document.createElement('div');
  const name = document.createElement('dt');
  const data = document.createElement('dd');
  name.textContent = term;
  data.textContent = value;
  wrapper.append(name, data);
  return wrapper;
}

async function request(path, body, signal) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  };
  const response = await fetch(path, {cache: 'no-store', signal, ...options});
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) throw new Error(data?.error || '서버 요청에 실패했습니다 (' + response.status + ').');
  return data;
}

let cadVolume=0;
function sweepEstimate() {
  const hex = byId('mesh-method').value.startsWith('hex-');
  byId('sweep-settings').hidden=!hex;
  if (!hex) return;
  const face=planarFaces.get(ports.inlet.value);
  const size=byId('mesh-size').valueAsNumber;
  let hint='직사각 입구를 선택하면 단면 분할과 예상 셀 수가 표시됩니다.';
  if(face?.rectangle_mm && size>0){
    const [w,h]=face.rectangle_mm;
    const nw=byId('width-cells').valueAsNumber || Math.max(2,Math.ceil(Number((w/size).toFixed(8))));
    const nh=byId('height-cells').valueAsNumber || Math.max(2,Math.ceil(Number((h/size).toFixed(8))));
    const length=Math.ceil(cadVolume/face.area_mm2/size);
    hint='입구 '+format(w)+' × '+format(h)+' mm · '+nw+' × '+nh+'셀 · 중심선 길이 기준 약 '+format(nw*nh*length)+'셀';
  }
  byId('sweep-estimate').textContent=hint;
}
for(const id of ['mesh-method','mesh-size','width-cells','height-cells']) byId(id).addEventListener('input',sweepEstimate);
function refreshButtons() {
  sweepEstimate();
  const selected = Boolean(ports.inlet.value && ports.outlet.value) && ports.inlet.value !== ports.outlet.value;
  const setUp = Boolean(documentState) && planarFaces.size >= 2;
  const hasMesh = Boolean(environment?.mesh_ready);
  const hasSolver = Boolean(environment?.ready);
  byId('setup-fields').disabled = !setUp || submitting;
  byId('open-model').disabled = submitting;
  byId('mesh-button').disabled = submitting || !selected || !setUp || !hasMesh;
  byId('solve-button').disabled = submitting || !selected || !setUp || !hasMesh || !hasSolver;
  byId('mesh-button').classList.toggle('mesh-secondary', hasSolver);
  let text = '';
  if (environment) {
    if (!hasMesh) text = '격자를 생성하려면 Gmsh 실행 환경이 필요합니다.';
    else if (!hasSolver) text = '이 환경에서는 격자를 만들고 케이스 파일을 저장할 수 있습니다. 솔버 실행에는 OpenFOAM v14가 필요합니다.';
    else if (setUp && !selected) text = '입구와 출구를 서로 다른 면으로 지정하세요.';
  }
  byId('flow-availability').textContent = text;
  const savedGrid = canReuseMesh(shownRun);
  const solverReady = canRunSolver();
  byId('solve-mesh-button').disabled = submitting || !savedGrid || !solverReady;
  byId('mesh-solve-fields').disabled = submitting;
  byId('mesh-solve-cancel').disabled = submitting;
  byId('mesh-solve-submit').disabled = submitting || !solverReady;
  byId('mesh-solve-availability').textContent = !savedGrid
    ? '격자가 저장되면 이 격자로 해석할 수 있습니다.'
    : !environment ? 'OpenFOAM 실행 환경 확인 중'
    : solverReady ? '선택한 격자와 입구·출구를 그대로 사용합니다.'
    : environment.solver_problems?.[0] || 'OpenFOAM Foundation v14가 준비되면 이 격자로 해석할 수 있습니다.';
}

function canRunSolver() {
  return Boolean(environment?.solver_ready ?? environment?.ready);
}

function canReuseMesh(run) {
  return Boolean(run?.files?.mesh && ['complete', 'failed'].includes(run.status));
}

function defaultComputeBackend() {
  return environment?.gpu_pressure_ready ? 'gpu-pressure' : 'cpu';
}

function showEnvironment(value) {
  environment = value;
  for (const prefix of ['', 'saved-']) {
    byId(prefix + 'compute-backend').options[1].disabled = !value.gpu_pressure_ready;
  }
  byId('compute-backend').value = defaultComputeBackend();
  const {ready, version, commands, mesh_ready: meshReady} = value;
  const solverReady = canRunSolver();
  const label = ready ? 'OpenFOAM v14 준비됨' : solverReady ? '저장 격자 해석 가능'
    : meshReady ? '격자 생성 가능' : '실행 환경 미준비';
  badge(byId('environment-badge'), label, solverReady ? 'success' : 'warning');
  byId('environment-caption').textContent = ready ? '격자와 솔버 사용 가능'
    : solverReady ? '저장된 격자로 해석 가능' : '환경 세부 정보';
  const rows = [
    ['Gmsh', meshReady ? '사용 가능' : '미준비'],
    ['CUDA 압력 가속', value.gpu_pressure_ready ? '사용 가능' : '미준비'],
    ['OpenFOAM', version ? version + (value.solver_backend === 'wsl' ? ' (WSL)' : '') : '감지되지 않음'],
    ...Object.entries(commands ?? {}).map(([name, path]) => [name, path || '찾을 수 없음']),
  ];
  byId('command-list').replaceChildren(...rows.map(([term, result]) => description(term, result)));
  const problems = [...new Set([...(value.mesh_problems ?? []), ...(value.problems ?? [])])];
  const list = byId('environment-problems');
  list.replaceChildren(...problems.map((problem) => {
    const item = document.createElement('li');
    item.textContent = problem;
    return item;
  }));
  list.hidden = !problems.length;
  refreshButtons();
}

function faceLabel(face) {
  const point = face.center_mm.map((value) => format(Math.abs(value) < 1e-9 ? 0 : value)).join(', ');
  return '면 ' + (face.id + 1) + ' · ' + format(face.area_mm2, 'mm²') + ' · (' + point + ') mm';
}

function renderFaceOptions() {
  for (const select of Object.values(ports)) {
    const first = new Option('면 선택', '');
    first.disabled = true;
    select.replaceChildren(first, ...[...planarFaces.values()].map((face) => new Option(faceLabel(face), face.ref)));
    select.value = '';
  }
}

function setActivePort(role) {
  activePort = role;
  document.querySelector('input[name="pick-role"][value="' + role + '"]').checked = true;
  byId('port-view').disabled = !planarFaces.get(ports[role].value)?.plane;
}

function inletArea() {
  return planarFaces.get(ports.inlet.value)?.area_mm2;
}

function updateInletEquivalent() {
  const speed = inletSpeed('', inletArea());
  const area = inletArea();
  const help = byId('inlet-equivalent');
  help.hidden = !(area > 0 && speed >= 0);
  help.textContent = help.hidden ? '' : byId('inlet-condition').value === 'flow'
    ? '입구 평균속도 ' + format(speed, 'm/s')
    : '입구 체적 유량 ' + format(speed * 60 * area, 'mL/min');
}

function syncPorts() {
  ports.inlet.querySelectorAll('option').forEach((option) => {
    option.disabled = !option.value || option.value === ports.outlet.value;
  });
  ports.outlet.querySelectorAll('option').forEach((option) => {
    option.disabled = !option.value || option.value === ports.inlet.value;
  });
  viewport?.setFaceHighlights(Object.entries(ports).flatMap(([role, select]) => {
    const face = planarFaces.get(select.value);
    return face ? [{id: face.id, color: portColors[role]}] : [];
  }));
  setActivePort(activePort);
  updateInletEquivalent();
  refreshButtons();
}

function setPort(role, ref) {
  const other = role === 'inlet' ? 'outlet' : 'inlet';
  if (ref === ports[other].value) {
    byId('pick-status').textContent = '이 면은 이미 ' + roleLabels[other] + '입니다. 다른 면을 지정하세요.';
    return;
  }
  const face = planarFaces.get(ref);
  if (!face) {
    byId('pick-status').textContent = '입구와 출구에는 유체 체적의 평면을 지정하세요.';
    return;
  }
  ports[role].value = ref;
  setActivePort(ports[other].value ? role : other);
  byId('pick-status').textContent = roleLabels[role] + ' · ' + faceLabel(face);
  syncPorts();
}

function clearDomain() {
  documentState = null;
  planarFaces = new Map();
  byId('domain-preview').hidden = true;
  byId('domain-volume').hidden = true;
  byId('domain-status').hidden = false;
  viewport?.setModel(null);
  renderFaceOptions();
  syncPorts();
}

function showDomain(domain, source) {
  cadVolume=domain.volume;
  if (!domain) throw new Error('3D CAD에서 절삭으로 유체 체적을 지정하거나 유체 체적이 있는 프로젝트를 여세요.');
  documentState = source;
  planarFaces = new Map(domain.faces.filter((face) =>
    typeof face.ref === 'string' && face.area_mm2 > 0 && Array.isArray(face.center_mm),
  ).map((face) => [face.ref, face]));
  const dimensions = domain.bounds.slice(3).map((value, axis) => format(value - domain.bounds[axis])).join(' × ');
  badge(byId('domain-volume'), format(domain.volume, 'mm³'));
  byId('domain-volume').hidden = false;
  byId('domain-status').textContent = dimensions + ' mm (X × Y × Z) · ' + planarFaces.size + '개 선택 가능한 평면';
  if (domain.solids !== 1) {
    byId('domain-status').textContent += ' · 연결된 유체 체적 하나를 사용하세요.';
    documentState = null;
  } else if (planarFaces.size < 2) {
    byId('domain-status').textContent += ' · 입구와 출구에 쓸 평면이 두 개 필요합니다.';
  }
  renderFaceOptions();
  byId('pick-status').textContent = faceHelp;
  setActivePort('inlet');
  if (viewport) {
    byId('domain-preview').hidden = false;
    viewport.setModel({domain});
    viewport.setFocus('domain');
    viewport.setView('iso');
    viewport.fit();
  }
  syncPorts();
}

let currentRevision = null;
async function loadDomain(source) {
  currentRevision = null;
  const version = ++domainVersion;
  clearDomain();
  byId('domain-status').textContent = 'CAD 모델 불러오는 중';
  if (!source || source.version !== 1 || !Array.isArray(source.operations)) {
    byId('domain-status').textContent = '3D CAD에서 유체 체적을 만든 뒤 유동해석 설정을 열거나 CAD 프로젝트를 여세요.';
    return;
  }
  try {
    const {domain,revision} = await request('/api/flow/domain', source);
    if (version === domainVersion) {currentRevision = revision; showDomain(domain, source); showProgress(shownRun);}
  } catch (error) {
    if (version === domainVersion) byId('domain-status').textContent = error.message;
  }
}

function runLabel(run) {
  if (run.result_source === 'sample') return '컨투어 예시 · 시험용 데이터';
  const type = run.setup?.mesh_only || run.mesh_only
    ? (meshNames[run.mesh?.method ?? run.setup?.mesh_method ?? 'gmsh-tetra'])
    : run.setup?.mode === 'transient' ? '비정상 유동' : '정상 유동';
  const gpu = !run.mesh_only && run.setup?.compute_backend === 'gpu-pressure' ? ' · GPU 압력' : '';
  return type + gpu + ' · ' + format(run.setup?.mesh_mm, 'mm') + (run.source_mesh_id ? ' · 저장 격자 사용' : '');
}

function chooseRun(id, method) {
  if (method) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('run', id);
    else url.searchParams.delete('run');
    if (url.href !== location.href) history[method](null, '', url);
  }
  if (id === chosen) return;
  chosen = id;
  logKey = '';
  logVersion++;
  byId('log-panel').open = false;
  showRun(null);
}

function showHistory(runs) {
  const key = JSON.stringify([byId('archived-runs').checked, chosen, runs.map((run) => [run.id, run.status, run.label, run.stop_requested])]);
  if (key === historyKey) return;
  historyKey = key;
  byId('history-empty').hidden = runs.length > 0;
  const list = byId('history-list');
  const focused = list.contains(document.activeElement) && document.activeElement.dataset.run;
  const scroll = list.scrollTop;
  list.replaceChildren(...runs.map((run) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const id = document.createElement('span');
    const conditions = document.createElement('span');
    const status = document.createElement('span');
    button.type = 'button';
    button.dataset.run = run.id;
    button.setAttribute('aria-current', String(run.id === chosen));
    id.textContent = run.label || run.setup?.project_name || run.id;
    button.title = run.id;
    id.className = 'history-id';
    conditions.textContent = runLabel(run);
    conditions.className = 'history-mesh';
    status.className = 'badge';
    badge(status, ...(states[run.status] ?? states.queued));
    button.append(id, conditions, status);
    if (!run.archived) button.onclick = () => {
      chooseRun(run.id, 'pushState');
      navigateStep(run.status === 'complete' ? (run.mesh_only ? 'mesh' : 'results') : 'run');
      refresh();
    };
    else button.disabled = true;
    if (!run.archived) button.setAttribute('aria-label', id.textContent + ' 불러오기');
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (!run.archived) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 80;
      input.value = run.label || '';
      input.placeholder = '실행 이름';
      input.setAttribute('aria-label', run.id + ' 실행 이름');
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = '이름 저장';
      save.onclick = () => changeHistoryRun(run.id, 'label', {label: input.value});
      input.onkeydown = (event) => { if (event.key === 'Enter') save.click(); };
      actions.append(input, save);
    }
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.textContent = run.archived ? '복원' : '삭제';
    archive.disabled = ['queued', 'running'].includes(run.status);
    archive.onclick = () => changeHistoryRun(run.id, run.archived ? 'restore' : 'archive', {});
    actions.append(archive);
    item.append(button, actions);
    return item;
  }));
  list.scrollTop = scroll;
  if (focused) [...list.querySelectorAll('button')].find((button) => button.dataset.run === focused)?.focus({preventScroll: true});
}

function showProgress(run) {
  const output = byId('open-run-output');
  output.hidden = run?.status !== 'complete';
  output.textContent = run?.mesh_only ? '생성 격자 보기' : '해석 결과 보기';
  output.onclick = () => navigateStep(run.mesh_only ? 'mesh' : 'results');
  const sample = run?.result_source === 'sample';
  badge(byId('run-status'), ...(sample ? ['시험용 데이터', 'warning'] : (states[run?.status] ?? states.queued)));
  byId('flow-stages').hidden = sample;
  byId('run-description').textContent = run
    ? run.id + ' · ' + runLabel(run) + (run.source_mesh_id ? ' (' + run.source_mesh_id + ')' : '')
    : '입구와 출구를 지정한 뒤 격자를 생성하거나 유동해석을 실행하세요.';
  const manage=byId('run-management');
  manage.hidden = !run;
  if (run && manage.dataset.id!==run.id) {
    manage.dataset.id=run.id;
    byId('run-name').value=run.label || '';
  }
  byId('stop-run').hidden=!run || !['running','queued'].includes(run.status);
  byId('stop-run').disabled=Boolean(run?.stop_requested);
  byId('stop-run').textContent=run?.stop_requested ? '중지 요청됨' : run?.status==='queued' ? '대기 취소' : '해석 중단';
  const saved=run?.setup?.cad_revision;
  byId('run-version').textContent=saved ? (run.setup.project_name || '')+' · CAD '+saved+
    (currentRevision && currentRevision!==saved?' · 현재 형상 버전과 다름':'') : '';
  const current = stages.findIndex((step) => step.dataset.stage === run?.stage);
  const gridOnly = run?.setup?.mesh_only || run?.mesh_only;
  stages.forEach((step, index) => {
    let label = '대기';
    let state = '';
    if (run?.source_mesh_id && step.dataset.stage === 'mesh') {
      label = '저장 격자 사용';
      if (index < current || run.status === 'complete') state = 'done';
    } else if (gridOnly && index > 1) label = '생략';
    else if (run && (run.status === 'complete' || index < current)) [label, state] = ['완료', 'done'];
    else if (run && index === current && run.status === 'running') [label, state] = ['진행 중', 'active'];
    else if (run && index === current && run.status === 'failed') [label, state] = ['실패', 'error'];
    step.dataset.state = state;
    if (state === 'active') step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
    step.querySelector('small').textContent = label;
  });
  notice('run-error', run?.error || '');
}

function updateLogs(run) {
  const panel = byId('log-panel');
  const picker = byId('log-select');
  const logs = run?.logs ?? [];
  panel.hidden = !logs.length;
  if (!logs.length) return;
  const names = [...picker.options].map((option) => option.value);
  if (JSON.stringify(names) !== JSON.stringify(logs)) {
    const previous = picker.value;
    picker.replaceChildren(...logs.map((name) => new Option(name, name)));
    picker.value = (panel.open && logs.includes(previous) ? previous : null)
      ?? (logs.includes(logForStage[run.stage]) ? logForStage[run.stage] : logs.at(-1));
  }
  if (panel.open) showLog();
}

async function showLog() {
  const name = byId('log-select').value;
  const run = shownRun;
  if (!run?.logs?.includes(name)) return;
  const key = run.id + '/' + name + '/' + run.status;
  if (key === logKey && run.status !== 'running') return;
  const version = ++logVersion;
  if (key !== logKey) byId('log-text').textContent = '로그 불러오는 중';
  logKey = key;
  try {
    const value = await request(runPath + '/' + run.id + '/logs/' + encodeURIComponent(name));
    if (version === logVersion) byId('log-text').textContent = (value.truncated ? '최근 로그만 표시함\n\n' : '') + value.text;
  } catch (error) {
    if (version === logVersion) {
      byId('log-text').textContent = error.message;
      logKey = '';
    }
  }
}

function download(id, run, key, filename) {
  const link = byId(id);
  link.hidden = !run?.files?.[key];
  if (link.hidden) link.removeAttribute('href');
  else link.href = runPath + '/' + run.id + '/' + filename;
}

function surfaceEdges(data) {
  const edges = new Map();
  const points = data.points_mm;
  for (const polygons of Object.values(data.patches)) {
    for (const polygon of polygons) {
      for (let index = 0; index < polygon.length; index++) {
        const first = polygon[index];
        const next = polygon[(index + 1) % polygon.length];
        const start = Math.min(first, next), end = Math.max(first, next);
        const key = start * points.length + end;
        if (!edges.has(key)) edges.set(key, [...points[start], ...points[end]]);
      }
    }
  }
  return [...edges.values()];
}

function meshSurface(runId) {
  if (!meshSurfaceCache.has(runId)) {
    if (meshSurfaceCache.size >= 3) meshSurfaceCache.delete(meshSurfaceCache.keys().next().value);
    const load = request(runPath + '/' + runId + '/mesh-preview').then(data => ({
      data, wireframe: {bounds: data.bounds_mm, edges: surfaceEdges(data), truncated: data.truncated},
    })).catch(error => {
      if (meshSurfaceCache.get(runId) === load) meshSurfaceCache.delete(runId);
      throw error;
    });
    meshSurfaceCache.set(runId, load);
  }
  return meshSurfaceCache.get(runId);
}

async function wireframeForRun(runId) {
  try {
    return (await meshSurface(runId)).wireframe;
  } catch {
    return null;
  }
}

function meshModel(data, axis, surfaceWireframe) {
  const groups = axis ? {section: data.section} : data.patches;
  const points = data.points_mm;
  const faces = [];
  const edges = axis
    ? data.section_edges.map(([start, end]) => [...points[start], ...points[end]])
    : surfaceWireframe.edges;
  for (const [name, polygons] of Object.entries(groups)) {
    if (!polygons.length) continue;
    const positions = [];
    for (const polygon of polygons) {
      for (let index = 1; index + 1 < polygon.length; index++) {
        positions.push(...points[polygon[0]], ...points[polygon[index]], ...points[polygon[index + 1]]);
      }
    }
    faces.push({id: name, positions, color: gridColors[name]});
  }
  const bounds = [...data.bounds_mm];
  if (axis) {
    const coordinate = sectionAxes.indexOf(axis);
    bounds[coordinate] = bounds[coordinate + 3] = data.section_position_mm;
  }
  return {domain: faces.length ? {bounds, faces, edges} : null, wireframe: axis ? surfaceWireframe : null};
}

function sliceFraction() {
  const slider = byId('mesh-position');
  return slider.valueAsNumber / Number(slider.max);
}

function showSlicePosition() {
  const axis = byId('mesh-section').value;
  const index = sectionAxes.indexOf(axis);
  const value = meshBounds?.[index] + (meshBounds?.[index + 3] - meshBounds?.[index]) * sliceFraction();
  const text = axis.toUpperCase() + ' = ' + format(Math.abs(value) < 1e-9 ? 0 : value, 'mm');
  byId('mesh-position-value').textContent = text;
  byId('mesh-position').setAttribute('aria-valuetext', text);
}

async function loadMeshPreview(resetView) {
  if (!meshRunId || !meshViewport) return;
  previewAbort?.abort();
  const controller = new AbortController();
  previewAbort = controller;
  const axis = byId('mesh-section').value;
  const fraction = sliceFraction();
  const parameters = axis ? '?' + new URLSearchParams({axis, fraction}) : '';
  notice('mesh-preview-status', axis ? '단면 계산 중' : '격자 불러오는 중');
  try {
    if (axis==='quality') {
      const [q,surface]=await Promise.all([request(runPath+'/'+meshRunId+'/quality-map',undefined,controller.signal),meshSurface(meshRunId)]);
      if(controller.signal.aborted) return;
      const bounds=surface.data.bounds_mm;
      const r=Math.max(...bounds.slice(3).map((v,i)=>v-bounds[i]))/220;
      const positions=[];
      for (const [x,y,z] of q.points) {
        positions.push(x-r,y-r,z,x+r,y-r,z,x,y+r,z,x,y-r,z-r,x,y-r,z+r,x,y+r,z);
      }
      const domain=positions.length?{bounds,edges:[],faces:[{id:'low',positions,color:[1,0.35,0.12,1]}]}:null;
      meshViewport.setModel({domain,wireframe:surface.wireframe});
      meshViewport.setFocus('domain');
      if(resetView) meshViewport.fit();
      notice('mesh-preview-status', '직교성 최솟값 ' + format(q.minimum) + ' · 0.9 미달 ' + format(q.below) + '셀 (표시 ' + format(q.points.length) + '개)');
      byId('mesh-canvas').setAttribute('aria-label','직교 품질 미달 셀 위치');
      return;
    }
    let data, wireframe;
    if (axis) {
      [data, wireframe] = await Promise.all([
        request(runPath + '/' + meshRunId + '/mesh-preview' + parameters, undefined, controller.signal),
        wireframeForRun(meshRunId),
      ]);
    } else {
      ({data, wireframe} = await meshSurface(meshRunId));
    }
    if (controller.signal.aborted) return;
    meshBounds = data.bounds_mm;
    if (axis) showSlicePosition();
    const model = meshModel(data, axis, wireframe);
    meshViewport.setModel(model);
    if (model.domain || model.wireframe) {
      meshViewport.setFocus('domain');
      if (resetView) {
        meshViewport.setView('iso');
        meshViewport.fit();
      }
    }
    const canvas = byId('mesh-canvas');
    const counts = data.cell_counts;
    const label = counts?.hexahedra ? ((counts.tetrahedra || counts.prisms) ? '혼합 격자' : '육면체 격자') : '사면체 격자';
    canvas.setAttribute('aria-label', axis
      ? label + ' 단면, ' + byId('mesh-position-value').textContent : '입구·출구·벽 ' + label + ' 표면');
    let message = '';
    if (!model.domain) message = '현재 위치를 지나는 격자 셀이 없습니다.';
    else if (axis) message = '단면의 격자 셀 ' + format(data.section_cells) + '개';
    if (axis && wireframe) message += ' · 전체 외곽 와이어프레임';
    if (data.truncated || wireframe?.truncated) message += (message ? ' · ' : '') + '화면에 격자의 일부를 표시합니다.';
    notice('mesh-preview-status', message);
  } catch (error) {
    if (controller.signal.aborted) return;
    meshViewport.setModel(null);
    notice('mesh-preview-status', error.message);
  }
}

function showMeshPreview(run) {
  const next = run?.files?.mesh ? run.id : null;
  if (next === meshRunId) return;
  meshRunId = next;
  meshBounds = null;
  previewAbort?.abort();
  clearTimeout(previewTimer);
  meshViewport?.setModel(null);
  notice('mesh-preview-status', '');
  byId('mesh-preview').hidden = !meshRunId;
  if (!meshRunId) return;
  if (!meshViewport) {
    try {
      meshViewport = createViewport(byId('mesh-canvas'), {inspectMesh: true});
    } catch {
      byId('mesh-preview').hidden = true;
      notice('mesh-preview-status', '이 브라우저에서 3D 격자 보기를 열 수 없습니다.');
      return;
    }
  }
  byId('mesh-section').value = '';
  byId('mesh-position').value = 500;
  byId('mesh-slice').hidden = true;
  byId('mesh-section-view').hidden = true;
  byId('mesh-patch-key').hidden = false;
  loadMeshPreview(true);
}

function showMesh(run) {
  showMeshPreview(run);
  const mesh = run?.mesh;
  const card = byId('mesh-results');
  const wasHidden = card.hidden;
  card.hidden = !mesh && !run?.files?.case && !run?.files?.mesh;
  byId('mesh-empty-step').hidden = !card.hidden;
  loadQuality(run?.files?.mesh ? run.id : '');
  if (card.hidden) return;
  if (wasHidden && location.hash === '#mesh-results') card.scrollIntoView();
  download('mesh-link', run, 'mesh', 'domain.msh');
  download('quality-link', run, 'quality', 'orthogonal-quality.csv');
  download('case-link', run, 'case', 'case.zip');
  const faces = mesh?.patch_faces;
  const quality = mesh?.orthogonal_quality;
  const isHex = mesh?.method === 'hex-sweep';
  notice('mesh-quality-summary', quality
    ? '직교 품질 최솟값 ' + format(quality.min) + ' · ' +
      '기준 ' + format(quality.target_min) + ' 미달 ' + format(quality.below_target) + '셀' : '');
  const rows = mesh ? [
    ['격자 방식', meshNames[mesh.method] || mesh.method],
    [isHex ? '육면체 셀' : '전체 셀', format(mesh.cells)],
    ...(mesh.cell_types ? [['육면체 / 삼각기둥', [mesh.cell_types.hexahedra, mesh.cell_types.prisms].map(n => format(n)).join(' / ')]] : []),
    ['격자점', format(mesh.nodes)],
    ['입구 면적', format(mesh.inlet_area_mm2, 'mm²')],
    ['출구 면적', format(mesh.outlet_area_mm2, 'mm²')],
    ['입구 / 출구 / 벽 격자면', [faces?.inlet, faces?.outlet, faces?.walls].map((value) => format(value)).join(' / ')],
    ...(quality ? [
      ['직교 품질 평균', format(quality.average)],
      ['직교 품질 최댓값', format(quality.max)],
    ] : [['최소 격자 품질 (SICN)', format(mesh.quality_min_sicn)]]),
  ] : [];
  byId('mesh-data').replaceChildren(...rows.map(([term, value]) => description(term, value)));
  byId('mesh-note').textContent = run.setup?.mesh_only || run.mesh_only
    ? 'OpenFOAM 격자 검사는 해석 실행 시 진행됩니다.' : '';
}

function svgNode(name, attributes, value) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, attribute] of Object.entries(attributes)) node.setAttribute(key, attribute);
  if (value !== undefined) node.textContent = value;
  return node;
}

function drawChart(profile) {
  const chart = byId('velocity-chart');
  const axis = byId('chart-axis').value;
  const xKey = axis + '_m';
  const points = (profile ?? []).filter((point) => Number.isFinite(point[xKey]) && Number.isFinite(point.speed_m_s));
  if (!points.length) {
    chart.hidden = true;
    byId('chart-note').textContent = '표시할 셀 표본이 없습니다.';
    return;
  }
  chart.hidden = false;
  const locations = points.map((point) => point[xKey] * 1000);
  let min = Math.min(...locations);
  let max = Math.max(...locations);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.05, 0.001);
    min -= pad;
    max += pad;
  }
  const top = 20, bottom = 251, left = 101, right = 647;
  const speedMax = Math.max(...points.map((point) => point.speed_m_s)) || 1;
  const projectX = (x) => left + (x - min) / (max - min) * (right - left);
  const projectY = (y) => bottom - y / speedMax * (bottom - top);
  const line = (x1, y1, x2, y2, className) => svgNode('line', {x1, y1, x2, y2, class: className});
  const tick = new Intl.NumberFormat('ko-KR', {maximumSignificantDigits: 3, notation: 'compact'});
  const nodes = [];
  for (let index = 0; index <= 4; index++) {
    const fraction = index / 4;
    const xValue = min + fraction * (max - min), yValue = fraction * speedMax;
    const x = projectX(xValue), y = projectY(yValue);
    nodes.push(line(x, top, x, bottom, 'grid-line'), line(left, y, right, y, 'grid-line'));
    nodes.push(svgNode('text', {x, y: 276, 'text-anchor': 'middle'}, tick.format(xValue)));
    nodes.push(svgNode('text', {x: 90, y: y + 5, 'text-anchor': 'end'}, tick.format(yValue)));
  }
  nodes.push(line(left, bottom, right, bottom, 'axis-line'), line(left, top, left, bottom, 'axis-line'));
  nodes.push(svgNode('text', {x: (left + right) / 2, y: 306, class: 'axis-label', 'text-anchor': 'middle'}, axis.toUpperCase() + ' 좌표 (mm)'));
  nodes.push(svgNode('text', {x: 0, y: 0, class: 'axis-label', 'text-anchor': 'middle', transform: 'translate(27 135) rotate(-90)'}, '속력 (m/s)'));
  points.forEach((point, index) => nodes.push(svgNode('circle', {
    cx: projectX(locations[index]).toFixed(2), cy: projectY(point.speed_m_s).toFixed(2), r: 2.25, class: 'velocity-point',
  })));
  chart.replaceChildren(...nodes);
  byId('chart-note').textContent = '셀 중심 표본 ' + format(points.length) + '개를 표시합니다. CSV에서 전체 셀 값을 확인할 수 있습니다.';
}

function showResults(run) {
  const summary = run?.summary;
  const panel = byId('results-data');
  const empty = byId('results-empty');
  const live = Boolean(run?.frame && run.status === 'running');
  panel.hidden = !summary && !live;
  empty.hidden = Boolean(summary) || live;
  empty.textContent = run?.result_error || (run?.setup?.mesh_only || run?.mesh_only
    ? '격자 생성 실행에는 계산한 압력과 속도 값이 없습니다.'
    : '유동해석이 완료되면 입구와 출구의 평균 압력 및 셀별 속도를 표시합니다.');
  download('csv-link', run, 'csv', 'profile.csv');
  notice('sample-result-note', summary && run.result_source === 'sample'
    ? '표시 검증용 데이터입니다. OpenFOAM 솔버에서 계산한 유동 결과가 아닙니다.' : '');
  contourPanel.setRun(live ? {...run, contours: true} : summary ? run : null);
  const form = byId('live-inlet');
  form.hidden = !(run?.inlet_open && run.status === 'running');
  if (form.dataset.run !== (run?.id || '')) {
    form.dataset.run = run?.id || '';
    byId('live-rate').value = '';
    byId('live-message').textContent = '';
  }
  if (!form.hidden) byId('live-rate').placeholder = format(run.applied_ml_min);
  if (!summary) {
    byId('pressure-data').replaceChildren();
    byId('field-data').replaceChildren();
    byId('velocity-chart').replaceChildren();
    byId('chart-note').textContent = '';
    notice('convergence-note', '');
  }
  const key = summary ? run.id : '';
  if (key === resultKey) return;
  resultKey = key;
  if (!summary) return;
  const pressure = [
    ['입구 평균 압력', format(summary.inlet_pressure_pa, 'Pa')],
    ['출구 평균 압력', format(summary.outlet_pressure_pa, 'Pa')],
    ['압력차 (입구 − 출구)', format(summary.pressure_drop_pa, 'Pa')],
  ];
  const facts = [
    ['전체 격자 수', format(summary.cells)],
    ['최대 속력', format(summary.max_speed_m_s, 'm/s')],
    ['셀 평균 속력', format(summary.mean_speed_m_s, 'm/s')],
    ['경계 유량 불일치율', format(summary.flux_imbalance_percent, '%')],
    [summary.mode === 'transient' ? '최종 해석 시간' : '최종 반복', summary.time_directory + (summary.mode === 'transient' ? ' s' : '')],
  ];
  byId('pressure-data').replaceChildren(...pressure.map(([term, value]) => description(term, value)));
  byId('field-data').replaceChildren(...facts.map(([term, value]) => description(term, value)));
  notice('convergence-note', summary.steady_converged === false ? '잔차 수렴 기준을 충족하기 전에 최대 반복수에 도달했습니다.' : '');
  drawChart(run.profile);
}

const comparison = byId('mesh-compare');
async function compareMeshes() {
  const id = comparison.dataset.run;
  if (!comparison.open || !id) return;
  const out = byId('compare-data');
  out.textContent = '격자 결과 불러오는 중';
  try {
    const rows = await request(runPath + '/' + id + '/comparison');
    if (comparison.dataset.run !== id) return;
    const table = document.createElement('table');
    const header = table.createTHead().insertRow();
    for (const title of ['격자', '목표 길이 (mm)', '셀 수', '최소 직교 품질', '최대 비직교각 (°)', '압력차 (Pa)', '이전 단계 대비', '폭 × 두께 × 길이', '유량 불일치 (%)', '수렴']) {
      const th = document.createElement('th');
      th.textContent = title;
      header.append(th);
    }
    const body = table.createTBody();
    const prior = new Map();
    for (const row of rows) {
      const previous = row.group && prior.get(row.group);
      if (row.group) prior.set(row.group,row.pressure);
      const tr = body.insertRow();
      if (row.id === id) tr.className = 'current-run';
      const link = document.createElement('a');
      link.href = '/flow?run=' + row.id + '#results-title';
      link.textContent = row.method === 'hex-sweep' ? '육면체 스윕' : row.method === 'gmsh-tetra' ? '사면체' : row.method;
      tr.insertCell().append(link);
      for (const value of [format(row.size), format(row.cells), row.quality == null ? '미기록' : format(row.quality),
        row.max_angle == null ? '미기록' : format(row.max_angle), format(row.pressure),
        previous ? format(100*(row.pressure-previous)/Math.abs(previous))+' %' : '—',
        row.divisions ? [row.divisions.width,row.divisions.thickness,row.divisions.length].join(' × ') : '—',
        row.imbalance == null ? '—' : Number(row.imbalance).toPrecision(3),
        row.converged == null ? '미기록' : row.converged ? '수렴' : '미수렴']) tr.insertCell().textContent = value;
    }
    out.replaceChildren(table);
    if (byId('profiles-compare').checked) {
      const profiles=document.createElement('table'), headings=profiles.createTHead().insertRow();
      for(const title of ['격자 · 셀 수',...Array.from({length:8},(_,i)=>(i*12.5)+'–'+((i+1)*12.5)+'%')]){
        const cell=document.createElement('th');cell.textContent=title;headings.append(cell);
      }
      const caption=profiles.createCaption(); caption.textContent='전체 Z 높이 구간별 단면적 가중 평균 속력 (m/s)';
      for(const row of rows){
        if(comparison.dataset.run!==id || !byId('profiles-compare').checked) return;
        const speeds=await request(runPath+'/'+row.id+'/mid-profile');
        const tr=profiles.insertRow();
        tr.insertCell().textContent=format(row.cells);
        for(const v of speeds) tr.insertCell().textContent=v==null?'—':format(v);
      }
      if(comparison.dataset.run===id && byId('profiles-compare').checked) out.append(profiles);
    }
    if (rows.length === 1) out.append('같은 유로와 경계조건으로 다른 격자를 계산하면 여기에 추가됩니다.');
  } catch (error) {
    if (comparison.dataset.run === id) out.textContent = error.message;
  }
}
comparison.ontoggle = compareMeshes;
byId('profiles-compare').onchange=compareMeshes;
byId('refine-three').onclick = async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await request(runPath + '/' + comparison.dataset.run + '/solve', {refine:true});
    byId('refine-status').textContent = '거친·중간·미세 격자 순으로 계산합니다. 실행 기록 ' + result.ids.join(' · ');
    refresh();
  } catch (error) { byId('refine-status').textContent = error.message; }
  finally { button.disabled = false; }
};

function showRun(run) {
  const comparable = run?.summary?.mode === 'steady' && run.result_source !== 'sample';
  comparison.hidden = !comparable;
  const id = comparable ? run.id : '';
  if (id !== comparison.dataset.run) {
    comparison.dataset.run = id;
    compareMeshes();
  }
  shownRun = run;
  const solverStarted = ['foamRun', 'postprocess'].includes(run?.stage) || run?.logs?.includes('log.foamRun');
  loadResiduals(solverStarted && run.result_source !== 'sample' && !run.mesh_only ? run : null);
  showProgress(run);
  updateLogs(run);
  showMesh(run);
  if (run && run.id === pendingMeshPreview && ['complete', 'failed', 'stopped'].includes(run.status)) {
    pendingMeshPreview = null;
    if (run.status === 'complete' && document.body.dataset.step === 'run') navigateStep('mesh');
  }
  showResults(run);
  refreshButtons();
}

async function refresh() {
  clearTimeout(pollId);
  const version = ++refreshVersion;
  try {
    const {runs} = await request(runPath);
    if (version !== refreshVersion) return;
    if (!chosen && runs.length) chooseRun(runs[0].id, 'replaceState');
    const selected = runs.find((run) => run.id === chosen);
    if (!selected && chosen) chooseRun(runs[0]?.id ?? null, 'replaceState');
    const finishedKey=runs.filter(r=>r.status==='complete' && r.setup.refinement_group).map(r=>r.id).join(',');
    if(comparison.dataset.finished!==finishedKey) {comparison.dataset.finished=finishedKey;compareMeshes();}
    const historyRuns = byId('archived-runs').checked ? (await request(runPath + '?archived=1')).runs : runs;
    if (version !== refreshVersion) return;
    showHistory(historyRuns);
    if (!chosen) showRun(null);
    if (chosen) {
      const record = runs.find((run) => run.id === chosen);
      if (!shownRun || shownRun.id !== record.id || shownRun.status !== record.status || ['queued', 'running'].includes(record.status)) {
        const run = await request(runPath + '/' + chosen);
        if (version !== refreshVersion) return;
        showRun(run);
      }
    }
    if (runs.some((run) => ['queued', 'running'].includes(run.status)) || ['queued', 'running'].includes(shownRun?.status)) {
      pollId = setTimeout(refresh, 850);
    }
  } catch (error) {
    if (version === refreshVersion) {
      notice('request-error', error.message);
      pollId = setTimeout(refresh, 2500);
    }
  }
}

async function submitRun(event) {
  event.preventDefault();
  if (submitting || !documentState) return;
  const meshOnly = event.submitter?.id === 'mesh-button' || !environment?.ready;
  const action = byId(meshOnly ? 'mesh-button' : 'solve-button');
  if (action.disabled) return;
  const body = {
    document: documentState, inlet_ref: ports.inlet.value, outlet_ref: ports.outlet.value,
    fluid: byId('fluid').value, rho: byId('rho').valueAsNumber, mu: byId('mu').valueAsNumber,
    ...boundaryInputs('', inletArea()), mesh_mm: byId('mesh-size').valueAsNumber, mesh_method: byId('mesh-method').value,
    width_cells:byId('width-cells').valueAsNumber || null,height_cells:byId('height-cells').valueAsNumber || null,
    compute_backend: byId('compute-backend').value,
    mode: byId('mode').value, end_time_s: byId('end-time').valueAsNumber,
    live: byId('mode').value === 'transient',
    step_count: byId('time-step').valueAsNumber, mesh_only: meshOnly,
  };
  submitting = true;
  refreshButtons();
  notice('request-error', '');
  try {
    Object.assign(body,timedInputs(''));
    const run = await request(runPath, body);
    pendingMeshPreview = meshOnly ? run.id : null;
    chooseRun(run.id, 'pushState');
    navigateStep('run');
    showRun(run);
    refresh();
  } catch (error) {
    notice('request-error', error.message);
  } finally {
    submitting = false;
    refreshButtons();
  }
}

function changeFluid(prefix) {
  const values = fluidValues[byId(prefix + 'fluid').value];
  if (!values) return;
  [byId(prefix + 'rho').value, byId(prefix + 'mu').value] = values;
  byId(prefix + 'temperature').value = 20;
  byId(prefix + 'reference-pressure').value = 101.325;
}

function addScheduleRow(prefix, values = {}) {
  const list = byId(prefix + 'schedule');
  if (list.children.length >= 100) return;
  const row = document.createElement('div');
  row.className = 'schedule-row';
  for (const [key, title] of [['time_s', '변경 시각 (s)'], ['ml_min', '입구 유량 (mL/min)']]) {
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = title;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.name = key;
    input.value = values[key] ?? '';
    label.append(input);
    row.append(label);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '삭제';
  remove.setAttribute('aria-label', '이 입구 유량 변경 행 삭제');
  remove.onclick = () => row.remove();
  row.append(remove);
  list.append(row);
}

function resetSchedule(prefix, rows = []) {
  byId(prefix + 'schedule').replaceChildren();
  if (rows.length) rows.forEach(row => addScheduleRow(prefix, row));
  else addScheduleRow(prefix);
}

function timedInputs(prefix) {
  if (byId(prefix + 'mode').value !== 'transient') return {};
  const schedule = [];
  for (const row of byId(prefix + 'schedule').children) {
    const [time, rate] = row.querySelectorAll('input');
    if (!time.value && !rate.value) continue;
    if (!time.value || !rate.value) throw new Error('입구 유량을 바꿀 시각과 유량을 모두 입력하세요.');
    schedule.push({time_s: time.valueAsNumber, ml_min: rate.valueAsNumber});
  }
  return {save_interval_s: byId(prefix + 'save-interval').valueAsNumber || null, flow_schedule: schedule};
}

function showTransientFields(prefix) {
  const transient = byId(prefix + 'mode').value === 'transient';
  byId(prefix + 'transient-fields').hidden = !transient;
  for (const id of ['end-time', 'time-step', 'save-interval', 'schedule-fields']) byId(prefix + id).disabled = !transient;
  showTimeStep(prefix);
}

function inletSpeed(prefix, area, unit = byId(prefix + 'inlet-unit').value) {
  const value = byId(prefix + 'inlet-value').valueAsNumber;
  if (unit in inletUnits.speed) return value * inletUnits.speed[unit];
  return value * inletUnits.flow[unit] / (60 * area);
}

function showInletUnits(prefix, selected) {
  const kind = byId(prefix + 'inlet-condition').value;
  const select = byId(prefix + 'inlet-unit');
  select.replaceChildren(...Object.keys(inletUnits[kind]).map(unit => new Option(unit, unit)));
  if (selected && Object.hasOwn(inletUnits[kind], selected)) select.value = selected;
  select.dataset.previous = select.value;
  byId(prefix + 'inlet-value-label').textContent = kind === 'flow' ? '입구 체적 유량' : '입구 속도';
}

function setInletValue(prefix, speed, area) {
  const unit = byId(prefix + 'inlet-unit').value;
  const converted = unit in inletUnits.speed ? speed / inletUnits.speed[unit] : speed * 60 * area / inletUnits.flow[unit];
  if (Number.isFinite(converted)) byId(prefix + 'inlet-value').value = Number(converted.toPrecision(12));
}

function changeInletUnits(prefix, area, changeKind) {
  const unit = byId(prefix + 'inlet-unit');
  const speed = inletSpeed(prefix, area, unit.dataset.previous);
  if (changeKind) showInletUnits(prefix);
  setInletValue(prefix, speed, area);
  unit.dataset.previous = unit.value;
  if (!prefix) updateInletEquivalent();
}

function showOutletFields(prefix) {
  const target = byId(prefix + 'outlet-mode').value === 'target';
  byId(prefix + 'outlet-target').hidden = !target;
  byId(prefix + 'outlet-pressure').disabled = !target;
}

function boundaryInputs(prefix, area) {
  const value = id => byId(prefix + id).value;
  const number = id => byId(prefix + id).valueAsNumber;
  return {
    inlet_speed_m_s: inletSpeed(prefix, area),
    inlet_kind: value('inlet-condition'),
    inlet_unit: value('inlet-unit'),
    outlet_mode: value('outlet-mode'),
    outlet_pressure_pa: number('outlet-pressure'),
    temperature_c: number('temperature'),
    reference_pressure_kpa: number('reference-pressure'),
  };
}

function sourceInletArea(run) {
  return run?.mesh?.inlet_area_mm2 ?? run?.setup?.inlet?.area_mm2;
}

function openMeshSolveDialog() {
  if (submitting || !canReuseMesh(shownRun) || !canRunSolver()) return;
  solveSource = shownRun;
  const setup = solveSource.setup;
  const values = {
    fluid: setup.fluid, rho: setup.rho, mu: setup.mu,
    'inlet-condition': setup.inlet_kind ?? 'speed',
    'outlet-mode': setup.outlet_mode ?? 'target', 'outlet-pressure': setup.outlet_pressure_pa,
    temperature: setup.temperature_c ?? 20, 'reference-pressure': setup.reference_pressure_kpa ?? 101.325,
    'compute-backend': defaultComputeBackend(),
    mode: setup.mode, 'end-time': setup.end_time_s ?? 0.1, 'time-step': setup.step_count ?? Math.max(1, Math.min(100000, Math.round((setup.end_time_s ?? 0.1) / (setup.time_step_s ?? 0.001)))), 'save-interval':setup.save_interval_s ?? '',
  };
  for (const [field, value] of Object.entries(values)) byId('saved-' + field).value = value;
  const inletArea = sourceInletArea(solveSource);
  if (!(inletArea > 0)) byId('saved-inlet-condition').value = 'speed';
  showInletUnits('saved-', setup.inlet_unit);
  setInletValue('saved-', setup.inlet_speed_m_s, inletArea);
  showOutletFields('saved-');
  resetSchedule('saved-', setup.flow_schedule);
  byId('saved-inlet-condition').options[1].disabled = !(inletArea > 0);
  byId('mesh-solve-source').textContent = solveSource.id + ' · 목표 격자 길이 '
    + format(setup.mesh_mm, 'mm') + ' · 입구 면적 ' + format(inletArea, 'mm²');
  showTransientFields('saved-');
  notice('mesh-solve-error', '');
  byId('mesh-solve-dialog').showModal();
}

async function submitSavedMesh(event) {
  event.preventDefault();
  if (submitting || !solveSource || !canRunSolver()) return;
  const source = solveSource;
  const body = {
    fluid: byId('saved-fluid').value, rho: byId('saved-rho').valueAsNumber, mu: byId('saved-mu').valueAsNumber,
    compute_backend: byId('saved-compute-backend').value,
    ...boundaryInputs('saved-', sourceInletArea(source)), mode: byId('saved-mode').value,
    end_time_s: byId('saved-end-time').valueAsNumber, step_count: byId('saved-time-step').valueAsNumber,
    live: byId('saved-mode').value === 'transient',
  };
  submitting = true;
  refreshButtons();
  notice('mesh-solve-error', '');
  notice('request-error', '');
  try {
    Object.assign(body,timedInputs('saved-'));
    const run = await request(runPath + '/' + source.id + '/solve', body);
    byId('mesh-solve-dialog').close();
    chooseRun(run.id, 'pushState');
    navigateStep('run');
    showRun(run);
    byId('run-progress').scrollIntoView({block: 'nearest'});
    refresh();
  } catch (error) {
    notice('mesh-solve-error', error.message);
  } finally {
    submitting = false;
    refreshButtons();
  }
}

for (const [role, select] of Object.entries(ports)) {
  select.onfocus = () => setActivePort(role);
  select.onchange = () => setPort(role, select.value);
}
document.querySelectorAll('input[name="pick-role"]').forEach((button) => {
  button.onchange = () => setActivePort(button.value);
});
document.querySelectorAll('[data-view]').forEach((button) => {
  button.onclick = () => viewport?.setView(button.dataset.view);
});
byId('port-view').onclick = () => viewport?.viewSketchPlane(planarFaces.get(ports[activePort].value)?.plane);
byId('fit-view').onclick = () => viewport?.fit();
document.querySelectorAll('[data-mesh-view]').forEach((button) => {
  button.onclick = () => {
    meshViewport?.setView(button.dataset.meshView);
    meshViewport?.fit();
  };
});
byId('mesh-fit').onclick = () => meshViewport?.fit();
byId('mesh-section-view').onclick = () => {
  meshViewport?.setView(sectionViews[byId('mesh-section').value]);
  meshViewport?.fit();
};
byId('mesh-section').onchange = (event) => {
  clearTimeout(previewTimer);
  const section = ['x','y','z'].includes(event.target.value);
  byId('mesh-slice').hidden = !section;
  byId('mesh-section-view').hidden = !section;
  byId('mesh-patch-key').hidden = section;
  if (section) showSlicePosition();
  loadMeshPreview(true);
};
byId('mesh-position').oninput = () => {
  showSlicePosition();
  clearTimeout(previewTimer);
  previewAbort?.abort();
  previewTimer = setTimeout(() => loadMeshPreview(false), 160);
};
byId('solve-mesh-button').onclick = openMeshSolveDialog;
byId('mesh-solve-form').onsubmit = submitSavedMesh;
byId('mesh-solve-dialog').onclose = () => { solveSource = null; };
byId('mesh-solve-dialog').oncancel = (event) => { if (submitting) event.preventDefault(); };
byId('mesh-solve-cancel').onclick = () => byId('mesh-solve-dialog').close();
byId('flow-form').onsubmit = submitRun;
async function controlRun(action,body) {
  if(!shownRun) return;
  try {
    await request(runPath+'/'+shownRun.id+'/'+action,body);
    shownRun=null;
    await refresh();
  } catch(error){ notice('request-error',error.message); }
}
byId('rename-run').onclick=()=>controlRun('label',{label:byId('run-name').value});
byId('stop-run').onclick = async () => {
  const button = byId('stop-run');
  button.disabled = true;
  await controlRun('stop', {});
  if (!shownRun?.stop_requested) button.disabled = false;
};
byId('live-inlet').onsubmit = async event => {
  event.preventDefault();
  const id = shownRun.id;
  const ml_min = byId('live-rate').valueAsNumber;
  try {
    await request(runPath + '/' + id + '/inlet', {ml_min});
    if (shownRun?.id === id) byId('live-message').textContent = format(ml_min) + ' mL/min 변경 접수';
  } catch (error) {
    if (shownRun?.id === id) byId('live-message').textContent = error.message;
  }
};
byId('open-model').onclick = () => byId('load-model').click();
byId('load-model').onchange = async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  notice('request-error', '');
  try {
    if (file.size > 6 * 1024 * 1024) throw new Error('CAD 프로젝트는 6 MiB까지 열 수 있습니다.');
    const source = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    await loadDomain(source);
  } catch (error) {
    notice('request-error', 'CAD 프로젝트를 읽을 수 없습니다. ' + error.message);
  }
};
for (const prefix of ['', 'saved-']) {
  byId(prefix + 'fluid').onchange = () => changeFluid(prefix);
  for (const id of ['rho', 'mu']) byId(prefix + id).oninput = () => { byId(prefix + 'fluid').value = 'custom'; };
  for (const id of ['end-time', 'time-step']) byId(prefix + id).oninput = () => showTimeStep(prefix);
  byId(prefix + 'mode').onchange = () => showTransientFields(prefix);
}
for (const prefix of ['', 'saved-']) {
  const area = prefix ? () => sourceInletArea(solveSource) : inletArea;
  byId(prefix + 'inlet-condition').onchange = () => changeInletUnits(prefix, area(), true);
  byId(prefix + 'inlet-unit').onchange = () => changeInletUnits(prefix, area(), false);
  byId(prefix + 'outlet-mode').onchange = () => showOutletFields(prefix);
  byId(prefix + 'schedule-add').onclick = () => addScheduleRow(prefix);
  showInletUnits(prefix);
  showOutletFields(prefix);
  resetSchedule(prefix);
}
byId('inlet-value').oninput = updateInletEquivalent;
byId('log-panel').ontoggle = () => { if (byId('log-panel').open) showLog(); };
byId('log-select').onchange = showLog;
byId('chart-axis').onchange = () => drawChart(shownRun?.profile);
const meshNames = {'gmsh-tetra': '사면체 · Delaunay', 'tetra-hxt': '사면체 · HXT',
  'hex-sweep': '육면체 스윕', 'hex-dominant': '헥스 도미넌트'};
const stepLinks = [...document.querySelectorAll('[data-step]')];
let qualityRun = '';
let residualKey = '';
let residualRequest;
function navigateStep(step, updateURL = true) {
  const active = stepLinks.find(link => link.dataset.step === step) || stepLinks[0];
  document.body.dataset.step = active.dataset.step;
  const host = byId(active.dataset.step === 'results' ? 'result-residuals' : 'run-residuals');
  const monitor = byId('solver-monitor');
  if (monitor.parentElement !== host) host.append(monitor);
  for (const link of stepLinks) {
    if (link === active) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
  if (updateURL && location.hash !== active.hash) history.pushState(null, '', active.hash);
}
for (const link of stepLinks) link.onclick = event => {
  event.preventDefault();
  navigateStep(link.dataset.step);
};
function currentStep() {
  return stepLinks.find(link => link.hash === location.hash)?.dataset.step ||
    (location.hash === '#results-contour' ? 'results' : 'setup');
}
navigateStep(currentStep(), false);

function showTimeStep(prefix) {
  const end = byId(prefix + 'end-time').valueAsNumber;
  const count = byId(prefix + 'time-step').valueAsNumber;
  byId(prefix + 'time-step-preview').textContent = end > 0 && count > 0
    ? '고정 시간 간격 Δt = ' + (end / count).toPrecision(5) + ' s' : '';
}

async function changeHistoryRun(id, action, body) {
  notice('request-error', '');
  try {
    await request(runPath + '/' + id + '/' + action, body);
    if (id === chosen) {
      if (action === 'archive') chooseRun(null, 'replaceState');
      else shownRun = null;
    }
    await refresh();
  } catch (error) {
    notice('request-error', error.message);
  }
}
byId('archived-runs').onchange = refresh;

function renderSpectrum(title, stats, reverse) {
  const section = document.createElement('section');
  const heading = document.createElement('h4');
  heading.textContent = title + ' · 최소 ' + format(stats.min) + ' / 평균 ' + format(stats.mean) + ' / 최대 ' + format(stats.max);
  const bands = document.createElement('ul');
  bands.className = 'quality-bands';
  const grades = ['매우 낮음', '낮음', '보통', '양호', '우수'];
  stats.counts.forEach((count, index) => {
    const item = document.createElement('li');
    const grade = reverse ? 4 - index : index;
    const label = document.createElement('strong');
    label.textContent = grades[grade];
    item.dataset.grade = grade;
    item.append(label, document.createElement('br'),
      stats.bands[index] + '–' + stats.bands[index + 1], document.createElement('br'), format(count) + '셀');
    if (reverse) bands.prepend(item);
    else bands.append(item);
  });
  section.append(heading, bands);
  return section;
}
async function loadQuality(id) {
  if (qualityRun === id) return;
  qualityRun = id;
  byId('quality-spectrum').replaceChildren();
  notice('quality-status', id ? '격자 전체 셀의 품질을 계산하는 중…' : '');
  if (!id) return;
  try {
    const q = await request(runPath + '/' + id + '/quality-map');
    if (qualityRun !== id) return;
    byId('quality-spectrum').replaceChildren(renderSpectrum('Orthogonality (직교성)', q.orthogonality, false),
      renderSpectrum('Skewness (각도 왜곡도)', q.skewness, true));
    notice('quality-status', '직교성 0.9 미달 ' + format(q.below) + '셀');
  } catch (error) {
    if (qualityRun === id) notice('quality-status', error.message);
  }
}

async function loadResiduals(run) {
  const id = run?.id ?? '';
  const key = run ? id + ':' + run.status + ':' + run.stage : '';
  const live = run?.status === 'running' && run.stage === 'foamRun';
  const chart = byId('residual-chart');
  const changed = residualKey !== key;
  const newRun = residualKey.split(':')[0] !== id;
  if (!changed && (!live || residualRequest)) return;
  residualKey = key;
  residualRequest?.abort();
  residualRequest = null;
  byId('solver-monitor').hidden = !id;
  const transient = run?.setup?.mode === 'transient';
  const total = run?.setup?.step_count;
  if (newRun) {
    chart.replaceChildren();
    notice('solver-step', transient ? '첫 시간 스텝 대기 중' + (total ? ' · 전체 ' + format(total) + '스텝' : '') : '');
    notice('residual-status', id ? '솔버 로그에서 잔차를 읽는 중…' : '');
  }
  if (!id) return;
  const controller = new AbortController();
  residualRequest = controller;
  try {
    const update = await request(runPath + '/' + id + '/residuals?progress=1', undefined, controller.signal);
    if (controller.signal.aborted) return;
    if (transient && update.step) {
      const step = '시간 스텝 ' + format(update.step) + (total ? ' / ' + format(total) : '');
      const time = ' · 해석 시간 ' + format(update.time, 's');
      notice('solver-step', step + time);
    }
    const rows = update.residuals;
    if (!rows.length) {
      notice('residual-status', live ? '첫 잔차가 기록되면 그래프가 표시됩니다.' : '솔버 잔차 기록이 없습니다.');
      return;
    }
    notice('residual-status', (live ? '계산 중 갱신 · ' : '') + '각 시점의 최대 초기 잔차 · 세로축 로그 눈금');
    const fields = [['p','#f6ba5c'],['Ux','#53cafa'],['Uy','#7ddba9'],['Uz','#f393cd']];
    const width = 700, height = 275, x0 = 65, x1 = 675, y0 = 18, y1 = 222;
    const x = t => x0 + (x1-x0) * (t-rows[0].time) / ((rows.at(-1).time-rows[0].time) || 1);
    const exponent = v => Math.log10(Math.max(v, 1e-16));
    let low = -1, high = 0;
    for (const row of rows) for (const [field] of fields) if (row[field] != null) {
      low = Math.min(low, Math.floor(exponent(row[field])));
      high = Math.max(high, Math.ceil(exponent(row[field])));
    }
    const y = e => y1 - (y1-y0) * (e-low)/(high-low);
    const svg = svgNode('svg', {viewBox:'0 0 '+width+' '+height, role:'img', 'aria-label':'OpenFOAM 압력 및 속도 성분 초기 잔차'});
    for (let e = high; e >= low; e -= Math.ceil((high-low)/6)) {
      svg.append(svgNode('line',{x1:x0,y1:y(e),x2:x1,y2:y(e),stroke:'currentColor',opacity:0.3}),
        svgNode('text',{x:x0-8,y:y(e)+4,fill:'currentColor','text-anchor':'end'},'1e'+e));
    }
    svg.append(svgNode('text',{x:(x0+x1)/2,y:252,fill:'currentColor','text-anchor':'middle'},
      (run.setup.mode === 'steady' ? '반복 단계' : '해석 시간 (s)') + ' · ' + rows[0].time + '–' + rows.at(-1).time));
    for (const [field,color] of fields) {
      const points = rows.filter(row => row[field] != null);
      const windowSize = Math.max(1, Math.ceil(points.length / 1200));
      const plotted = [];
      for (let i = 0; i < points.length; i += windowSize) {
        plotted.push(points.slice(i, i+windowSize).reduce((peak, row) => row[field] > peak[field] ? row : peak));
      }
      svg.append(svgNode('polyline',{points:plotted.map(row=>x(row.time)+','+y(exponent(row[field]))).join(' '),
        fill:'none',stroke:color,'stroke-width':2}));
      if (plotted.length === 1) svg.append(svgNode('circle',{cx:x(plotted[0].time),cy:y(exponent(plotted[0][field])),r:3,fill:color}));
      if (points.length) svg.append(svgNode('text',{x:440 + fields.findIndex(item=>item[0] === field)*55,y:271,fill:color},field));
    }
    chart.replaceChildren(svg);
  } catch (error) {
    if (!controller.signal.aborted) notice('residual-status', error.message);
  } finally {
    if (residualRequest === controller) residualRequest = null;
  }
}
const contourPanel = createContourPanel(request, wireframeForRun);
window.addEventListener('popstate', () => {
  navigateStep(currentStep(), false);
  chooseRun(new URL(location.href).searchParams.get('run'));
  refresh();
});

try {
  viewport = createViewport(byId('domain-canvas'), {
    onPick: (face) => { if (face) setPort(activePort, face.ref); },
  });
} catch {
  notice('view-error', '3D 보기를 열 수 없습니다. 경계 조건에서 면을 목록으로 선택하세요.');
}
let savedProject;
try {
  savedProject = JSON.parse(localStorage.getItem(projectKey));
} catch { /* The CAD file picker is still available. */ }
loadDomain(savedProject);
request('/api/flow/environment').then(showEnvironment).catch((error) => notice('request-error', error.message));
refresh();

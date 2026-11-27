import {createViewport, formatCount, formatDisplayNumber as format} from '/cad-view.js';

const colors = [
  [31, 41, 98], [33, 90, 170], [18, 153, 172],
  [84, 189, 110], [242, 213, 75], [243, 137, 51], [184, 44, 56],
];
const colorBins = 64;
const viewForAxis = {x: 'right', y: 'front', z: 'top', '': 'iso'};
const byId = (id) => document.getElementById(id);

function colorAt(fraction) {
  const t = Math.max(0, Math.min(1, fraction)) * (colors.length - 1);
  const index = Math.min(Math.floor(t), colors.length - 2);
  const blend = t - index;
  return colors[index].map((value, channel) => (value + blend * (colors[index + 1][channel] - value)) / 255).concat(1);
}

function contourModel(data, axis, wireframe) {
  const bins = Array.from({length: colorBins}, () => []);
  const span = data.maximum - data.minimum;
  for (let index = 0; index < data.polygons.length; index++) {
    const nodes = data.polygons[index];
    const fraction = span > 0 ? (data.values[index] - data.minimum) / span : 0.5;
    const bucket = Math.round(Math.max(0, Math.min(1, fraction)) * (colorBins - 1));
    for (let triangle = 1; triangle + 1 < nodes.length; triangle++) {
      const points = data.points_mm;
      bins[bucket].push(...points[nodes[0]], ...points[nodes[triangle]], ...points[nodes[triangle + 1]]);
    }
  }
  const faces = bins.flatMap((positions, id) => positions.length
    ? [{id, positions, color: colorAt(id / (colorBins - 1))}] : []);
  const bounds = [...data.bounds_mm];
  if (axis) {
    const index = 'xyz'.indexOf(axis);
    bounds[index] = bounds[index + 3] = data.position_mm;
  }
  return {domain: faces.length ? {faces, edges: [], bounds} : null, wireframe};
}

export function createContourPanel(request, wireframeForRun) {
  const panel = byId('results-contour');
  const controls = byId('contour-controls');
  const canvas = byId('contour-canvas');
  const field = byId('contour-field');
  const axis = byId('contour-axis');
  const position = byId('contour-position');
  const status = byId('contour-status');
  const legend = byId('contour-legend');
  const colorsBar = byId('contour-colors');
  const gradient = 'linear-gradient(90deg, ' + colors.map(rgb => 'rgb(' + rgb.join(', ') + ')').join(', ') + ')';
  let viewport;
  let runId;
  let frame;
  let transient;
  const slider = byId('frame-index');
  const play = byId('play-frames');
  let frames = [], timelineId = null, playing = false, playbackTimer;

  function pause() {
    clearTimeout(playbackTimer);
    playing = false;
    play.textContent = '재생';
  }

  const graph = byId('response-plot');
  function svg(tag, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v);
    if (text !== undefined) el.textContent=text;
    graph.append(el);
    return el;
  }
  function plotResponse() {
    graph.replaceChildren();
    const end = Number(frames.at(-1).time);
    const x = t => 112+540*Number(t)/end;
    for (const [key,label,base,color] of [['ml_min','유량 (mL/min)',53,'#81ddd3'],['pressure_drop_pa','압력차 (Pa)',120,'#ffbd79']]) {
      const values=frames.map(f=>f[key]);
      const lo=Math.min(...values), hi=Math.max(...values);
      const y=v=>base-32*(v-lo)/(hi-lo||1);
      svg('text',{x:4,y:base-16,fill:color},label);
      svg('text',{x:104,y:base-31,'text-anchor':'end'},format(hi));
      if(hi!==lo) svg('text',{x:104,y:base,'text-anchor':'end'},format(lo));
      svg('path',{d:'M112 '+base+' H652',stroke:'#53616a',fill:'none'});
      let path=key==='ml_min' ? 'M112 '+y(values[0]) : '';
      frames.forEach((f,i)=>{
        if(key==='ml_min') path+=' V'+y(values[i])+' H'+x(f.time);
        else path+=(i?' L':'M')+x(f.time)+' '+y(values[i]);
      });
      svg('path',{d:path,fill:'none',stroke:color,'stroke-width':2});
    }
    svg('text',{x:112,y:149},'0 s'); svg('text',{x:652,y:149,'text-anchor':'end'},format(end)+' s');
    svg('line',{id:'response-cursor',x1:652,x2:652,y1:12,y2:125,stroke:'#fff','stroke-dasharray':'3 3'});
  }
  graph.onclick = event => {
    if (!frames.length) return;
    const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(graph.getScreenCTM().inverse());
    const time=(point.x-112)/540*Number(frames.at(-1).time);
    slider.value=frames.reduce((best,f,i)=>Math.abs(f.time-time)<Math.abs(frames[best].time-time)?i:best,0);
    pause(); draw(false);
  };
  async function openTimeline(id) {
    try {
      const data = await request('/api/flow/runs/' + id + '/timeline');
      if (timelineId !== id || !data.frames.length) return;
      frames = data.frames;
      plotResponse();
      slider.max = frames.length - 1;
      slider.value = slider.max;
      const changes = frames.flatMap((item, i) => i && Math.abs(item.ml_min - frames[i-1].ml_min) > 1e-8 ? [i] : []);
      byId('frame-marks').replaceChildren(...changes.map(i => new Option('', String(i))));
      byId('rate-transitions').textContent = changes.map(i => format(Number(frames[i-1].time)) + ' s부터 ' +
        format(frames[i].ml_min) + ' mL/min').join(' · ');
      byId('playback').hidden = false;
      draw(false);
    } catch (error) {
      if (timelineId === id) status.textContent = error.message;
    }
  }

  slider.oninput = () => { pause(); draw(false); };
  play.onclick = () => {
    if (playing) { pause(); return; }
    playing = true;
    play.textContent = '일시정지';
    if (+slider.value >= frames.length - 1) slider.value = 0;
    draw(false);
  };
  let bounds;
  let requestInFlight;
  let timer;

  function selectedFraction() {
    return position.valueAsNumber / Number(position.max);
  }

  function updatePosition() {
    byId('contour-slice').hidden = !axis.value;
    byId('contour-section-view').hidden = !axis.value;
    if (!axis.value || !bounds) return;
    const index = 'xyz'.indexOf(axis.value);
    const offset = bounds[index] + selectedFraction() * (bounds[index + 3] - bounds[index]);
    const label = axis.value.toUpperCase() + ' = ' + format(Math.abs(offset) < 1e-10 ? 0 : offset) + ' mm';
    byId('contour-position-value').textContent = label;
    position.setAttribute('aria-valuetext', label);
  }

  async function draw(resetView) {
    if (!runId || !viewport) return;
    clearTimeout(playbackTimer);
    requestInFlight?.abort();
    const controller = new AbortController();
    requestInFlight = controller;
    const currentAxis = axis.value;
    const parameters = new URLSearchParams({field: field.value});
    if (frames.length) {
      parameters.set('time', frames[+slider.value].time);
      slider.setAttribute('aria-valuetext', format(Number(frames[+slider.value].time)) + ' s');
    }
    if (currentAxis) {
      parameters.set('axis', currentAxis);
      parameters.set('fraction', selectedFraction());
    }
    status.textContent = '컨투어 불러오는 중';
    try {
      const [data, wireframe] = await Promise.all([
        request('/api/flow/runs/' + runId + '/contour?' + parameters, undefined, controller.signal),
        currentAxis ? wireframeForRun(runId) : null,
      ]);
      if (controller.signal.aborted) return;
      if(frames.length) {
        const cursor = byId('response-cursor');
        const x = 112+540*Number(data.time_directory)/Number(frames.at(-1).time);
        cursor.setAttribute('x1',x); cursor.setAttribute('x2',x);
      }
      bounds = data.bounds_mm;
      updatePosition();
      const model = contourModel(data, currentAxis, wireframe);
      viewport.setModel(model);
      if (model.domain || model.wireframe) {
        viewport.setFocus('domain');
        if (resetView) {
          viewport.setView('iso');
          viewport.fit();
        }
      }
      const title = field.selectedOptions[0].textContent;
      const placement = currentAxis ? byId('contour-position-value').textContent : '유체 체적 표면';
      canvas.setAttribute('aria-label', title + ' 컨투어 · ' + placement);
      byId('frame-time').textContent = transient ? '해석 시간 ' + format(Number(data.time_directory)) + ' s' +
        (data.frame_ml_min == null ? '' : ' · 입구 ' + format(data.frame_ml_min) + ' mL/min') : '';
      legend.hidden = !model.domain;
      byId('contour-legend-label').textContent = title;
      byId('contour-min').textContent = format(data.minimum) + ' ' + data.unit;
      byId('contour-max').textContent = format(data.maximum) + ' ' + data.unit;
      colorsBar.style.background = data.minimum === data.maximum
        ? 'rgba(' + colorAt(0.5).slice(0, 3).map(component => Math.round(component * 255)).join(', ') + ', 1)'
        : gradient;
      const description = model.domain
        ? (currentAxis ? '단면의 셀 중심값' : '표면의 경계면 값') + ' · ' + formatCount(data.count) + '개'
        : '선택한 위치를 지나는 격자 셀이 없습니다.';
      status.textContent = description + (wireframe ? ' · 전체 외곽 와이어프레임' : '') +
        (data.truncated || wireframe?.truncated ? ' · 화면에 일부 요소 표시' : '');
      if (playing && +slider.value < frames.length - 1) {
        playbackTimer = setTimeout(() => { slider.stepUp(); draw(false); }, 240 / Number(byId('play-speed').value));
      } else pause();
    } catch (error) {
      if (controller.signal.aborted) return;
      pause();
      viewport.setModel(null);
      legend.hidden = true;
      status.textContent = error.message;
    }
  }

  function setRun(run) {
    const next = run?.contours ? run.id : null;
    const nextFrame = run?.frame;
    transient = run?.setup?.mode === 'transient';
    const completed = next && transient && run.status === 'complete' ? next : null;
    if (timelineId !== completed || runId !== next) {
      pause();
      frames = [];
      byId('playback').hidden = true;
      timelineId = completed;
      if (completed) openTimeline(completed);
    }
    if (next === runId) {
      if (next && frame !== nextFrame) { frame = nextFrame; draw(false); }
      return;
    }
    frame = nextFrame;
    byId('frame-time').textContent = '';
    runId = next;
    clearTimeout(timer);
    requestInFlight?.abort();
    viewport?.setModel(null);
    bounds = null;
    panel.hidden = !runId;
    legend.hidden = true;
    if (!runId) return;
    byId('contour-sample').hidden = run.result_source !== 'sample';
    if (!viewport) {
      try {
        viewport = createViewport(canvas, {inspectMesh: true});
      } catch {
        controls.hidden = true;
        status.textContent = '이 브라우저에서 3D 컨투어를 열 수 없습니다.';
        return;
      }
    }
    axis.value = 'z';
    position.value = 500;
    updatePosition();
    if (location.hash === '#results-contour') panel.scrollIntoView();
    draw(true);
  }

  field.onchange = () => { clearTimeout(timer); draw(false); };
  axis.onchange = () => { clearTimeout(timer); updatePosition(); draw(true); };
  position.oninput = () => {
    updatePosition();
    clearTimeout(timer);
    requestInFlight?.abort();
    timer = setTimeout(() => draw(false), 160);
  };
  byId('contour-fit').onclick = () => viewport?.fit();
  byId('contour-iso').onclick = () => viewport?.setView('iso');
  byId('contour-section-view').onclick = () => {
    viewport?.setView(viewForAxis[axis.value]);
    viewport?.fit();
  };
  return {setRun};
}

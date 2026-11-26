const byId = (id) => document.getElementById(id);

const statuses = {
  queued: ["대기", ""],
  running: ["실행 중", "active"],
  complete: ["완료", "success"],
  failed: ["실패", "error"],
};

const logByStage = {
  prepare: "log.make_case",
  environment: "log.Allrun",
  blockMesh: "log.blockMesh",
  checkMesh: "log.checkMesh",
  foamRun: "log.foamRun",
  postprocess: "log.centres",
};

const steps = [...document.querySelectorAll("#stages li")];
const initialRun = () => new URL(location.href).searchParams.get("run");
let selectedId = initialRun();
let currentRun = null;
let refreshVersion = 0;
let refreshTimer;
let logVersion = 0;
let chosenLog = null;
let loadedLogKey = null;
let historyKey;
let resultKey;
let connectionError = false;

async function request(path, options = {}) {
  const response = await fetch(path, {cache: "no-store", ...options});
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "HTTP " + response.status);
  }
  return data;
}

function badge(node, label, tone = "") {
  if (node.textContent !== label) node.textContent = label;
  node.dataset.tone = tone;
}

function notification(node, message) {
  if (node.textContent !== message) node.textContent = message;
  node.hidden = !message;
}

function description(term, value) {
  const wrapper = document.createElement("div");
  const name = document.createElement("dt");
  const data = document.createElement("dd");
  name.textContent = term;
  data.textContent = value;
  wrapper.append(name, data);
  return wrapper;
}

function showEnvironment(environment) {
  const {version, ready, demo, commands, problems} = environment;
  const label = demo ? "테스트 모드" : ready ? "OpenFOAM v14 감지됨" : "OpenFOAM 실행 환경 미준비";
  badge(byId("environment-badge"), label, demo || !ready ? "warning" : "success");
  byId("environment-caption").textContent = label;
  byId("run-button").textContent = demo ? "테스트 케이스 실행" : "케이스 실행";
  const rows = [description("WM_PROJECT_VERSION", version || "설정되지 않음")];
  for (const [name, path] of Object.entries(commands)) {
    rows.push(description(name, path || "찾을 수 없음"));
  }
  byId("command-list").replaceChildren(...rows);
  const problemList = byId("environment-problems");
  problemList.hidden = !problems.length;
  problemList.replaceChildren(...problems.map((problem) => {
    const item = document.createElement("li");
    item.textContent = problem;
    return item;
  }));
  byId("environment").open = !demo && !ready;
}

function writeSelection(id, method) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("run", id);
  else url.searchParams.delete("run");
  if (url.href !== location.href) history[method](null, "", url);
}

function selectRun(id, method) {
  if (method) writeSelection(id, method);
  if (id === selectedId) return;
  selectedId = id;
  chosenLog = null;
  loadedLogKey = null;
  logVersion += 1;
  byId("log-panel").open = false;
  showRun(null);
}

function showHistory(runs) {
  const newKey = JSON.stringify([selectedId, runs]);
  if (newKey === historyKey) return;
  historyKey = newKey;
  byId("history-empty").hidden = runs.length > 0;
  const list = byId("history-list");
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.run : null;
  const scroll = list.scrollTop;
  const entries = runs.map((run) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const number = document.createElement("span");
    const mesh = document.createElement("span");
    const state = document.createElement("span");
    button.type = "button";
    button.dataset.run = run.id;
    button.setAttribute("aria-current", String(run.id === selectedId));
    number.className = "history-id";
    number.textContent = run.id;
    mesh.className = "history-mesh";
    mesh.textContent = "nᵧ " + run.ny + (run.demo ? " · 테스트" : "");
    state.className = "badge";
    badge(state, ...statuses[run.status]);
    button.append(number, mesh, state);
    button.addEventListener("click", () => {
      selectRun(run.id, "pushState");
      refresh();
    });
    item.append(button);
    return item;
  });
  list.replaceChildren(...entries);
  list.scrollTop = scroll;
  if (focusedId) {
    [...list.querySelectorAll("button")].find((button) => button.dataset.run === focusedId)?.focus({preventScroll: true});
  }
}

function showProgress(run) {
  badge(byId("run-status"), ...(run ? statuses[run.status] : ["대기"]));
  byId("run-description").textContent = run
    ? "실행 " + run.id + " · nᵧ " + run.ny + (run.demo ? " · 테스트 데이터" : "")
    : "격자를 선택하고 케이스를 실행하세요.";
  const currentStep = steps.findIndex((step) => step.dataset.stage === run?.stage);
  const environmentFailure = run?.stage === "environment" && run.status === "failed";
  steps.forEach((step, index) => {
    let state = "";
    let label = "대기";
    if (run?.demo && ["blockMesh", "checkMesh", "foamRun"].includes(step.dataset.stage)) {
      label = "생략";
    } else if (run && (run.status === "complete" || index < currentStep || (environmentFailure && index === 0))) {
      state = "done";
      label = "완료";
    } else if (run && index === currentStep && run.status === "failed") {
      state = "error";
      label = "실패";
    } else if (run && index === currentStep && run.status === "running") {
      state = "active";
      label = "진행 중";
    }
    step.dataset.state = state;
    step.querySelector("small").textContent = label;
    if (state === "active") step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
  let error = "";
  if (run?.status === "failed") {
    error = (environmentFailure ? "실행 환경 확인 실패. " : "") + (run.error || "실행에 실패했습니다. 아래 로그를 확인하세요.");
  }
  notification(byId("run-error"), error);
}

function showLogs(run, previousRun) {
  const panel = byId("log-panel");
  const picker = byId("log-select");
  const logs = run?.logs || [];
  panel.hidden = logs.length === 0;
  if (!logs.length) return;
  if (run.status === "failed" && previousRun?.status !== "failed") panel.open = true;
  const preferred = run.status === "failed" && run.stage === "postprocess" ? "log.Allrun" : logByStage[run.stage];
  const path = logs.includes(chosenLog) ? chosenLog : logs.includes(preferred) ? preferred : logs.at(-1);
  if ([...picker.options].map((option) => option.value).join() !== logs.join()) {
    picker.replaceChildren(...logs.map((file) => new Option(file, file)));
  }
  picker.value = path;
  updateLog(run, path);
}

async function updateLog(run, file) {
  if (!run || !file || !byId("log-panel").open) return;
  const key = [run.id, run.status, file].join("/");
  if (key === loadedLogKey && !["queued", "running"].includes(run.status)) return;
  const version = ++logVersion;
  const area = byId("log-text");
  if (key !== loadedLogKey) area.textContent = "로그 읽는 중…";
  try {
    const URLPath = "/api/runs/" + encodeURIComponent(run.id) + "/logs/" + encodeURIComponent(file);
    const {text, truncated} = await request(URLPath);
    if (version !== logVersion || run.id !== selectedId) return;
    const follow = key !== loadedLogKey || area.scrollHeight - area.scrollTop - area.clientHeight < 20;
    const content = truncated ? "[로그 마지막 64 KiB]\n\n" + text : text || "기록된 로그가 없습니다.";
    if (area.textContent !== content) area.textContent = content;
    if (follow) area.scrollTop = area.scrollHeight;
    loadedLogKey = key;
  } catch (error) {
    if (version === logVersion && run.id === selectedId) {
      area.textContent = "로그를 읽을 수 없습니다. " + error.message;
      loadedLogKey = null;
    }
  }
}

const displayNumber = (value, places) => new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: places,
}).format(value);

function metric(value, unit) {
  if (!Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(2) + " " + unit;
  return displayNumber(value, 4) + " " + unit;
}

function showResults(run) {
  const available = run?.status === "complete" && run.summary && run.profile?.length > 0;
  const resultError = run?.result_error || "";
  const newKey = available ? run.id : resultError;
  if (resultKey === newKey) return;
  resultKey = newKey;
  const empty = byId("results-empty");
  empty.hidden = available;
  empty.textContent = resultError || "실행이 완료되면 압력차와 중앙 단면 속도 분포를 볼 수 있습니다.";
  byId("results-data").hidden = !available;
  const source = byId("result-source");
  source.hidden = !available;
  if (!available) return;
  const summary = run.summary;
  badge(source, run.demo ? "합성 테스트 데이터" : "OpenFOAM 계산 결과", run.demo ? "warning" : "success");
  byId("pressure-cfd").textContent = metric(summary.tap_dp_Pa, "Pa");
  byId("pressure-exact").textContent = metric(summary.tap_dp_exact_Pa, "Pa");
  byId("pressure-error").textContent = metric(summary.tap_dp_error_percent, "%");
  byId("pressure-taps").textContent = "x = " + metric(summary.tap_a_x_m * 1000, "mm") + " → " + metric(summary.tap_b_x_m * 1000, "mm");
  byId("cell-count").textContent = metric(summary.cells, "셀");
  byId("profile-error").textContent = metric(summary.centre_section_Ux_profile_relative_L2_percent, "%");
  byId("flux-error").textContent = summary.boundary_flux_imbalance_percent == null
    ? "확인 불가 · 입·출구 면 유량 없음"
    : metric(summary.boundary_flux_imbalance_percent, "%");
  const link = byId("csv-link");
  link.href = "/api/runs/" + encodeURIComponent(run.id) + "/profile.csv";
  link.download = run.id + (run.demo ? "-test" : "") + "-profile.csv";
  drawChart(run.profile);
}

function showRun(run) {
  const previousRun = currentRun;
  currentRun = run;
  showProgress(run);
  showLogs(run, previousRun);
  showResults(run);
}

async function refresh() {
  const version = ++refreshVersion;
  clearTimeout(refreshTimer);
  try {
    const {runs} = await request("/api/runs");
    if (refreshVersion !== version) return;
    if (!selectedId || !runs.some((run) => run.id === selectedId)) {
      selectRun(runs[0]?.id || null, "replaceState");
    }
    showHistory(runs);
    const id = selectedId;
    if (id) {
      const run = await request("/api/runs/" + encodeURIComponent(id));
      if (refreshVersion !== version || id !== selectedId) return;
      showRun(run);
    }
    if (connectionError) {
      notification(byId("request-error"), "");
      connectionError = false;
    }
  } catch (error) {
    if (refreshVersion === version) {
      connectionError = true;
      notification(byId("request-error"), "실행 정보를 불러오지 못했습니다. " + error.message);
    }
  } finally {
    if (refreshVersion === version) {
      const active = ["running", "queued"].includes(currentRun?.status);
      refreshTimer = setTimeout(refresh, active ? 750 : 4000);
    }
  }
}

function svgElement(name, attributes = {}, value) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, data] of Object.entries(attributes)) node.setAttribute(key, data);
  if (value !== undefined) node.textContent = value;
  return node;
}

function chartScale(points) {
  const speeds = points.flatMap(({Ux_CFD_m_s, Ux_exact_at_centre_m_s}) => [Ux_CFD_m_s, Ux_exact_at_centre_m_s]);
  const extentMin = Math.min(0, ...speeds);
  const extentMax = Math.max(1.5, ...speeds);
  const requestedStep = (extentMax - extentMin) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(requestedStep));
  const step = [1, 2, 2.5, 5, 10].map((multiplier) => multiplier * magnitude).find((increment) => increment >= requestedStep);
  const first = Math.floor(extentMin / step);
  const last = Math.ceil(extentMax / step);
  return Array.from({length: last - first + 1}, (_, index) => (index + first) * step);
}

function drawChart(profile) {
  const svg = byId("velocity-chart");
  const readout = byId("chart-readout");
  const points = [...profile].sort((a, b) => a.y_over_H - b.y_over_H);
  const plot = {left: 70, right: 662, top: 15, bottom: 319};
  const labels = chartScale(points);
  const domainMin = labels[0];
  const domainMax = labels.at(-1);
  const x = (u) => plot.left + (u - domainMin) / (domainMax - domainMin) * (plot.right - plot.left);
  const y = (height) => plot.bottom - height * (plot.bottom - plot.top);
  const line = (x1, y1, x2, y2, cssClass) => svgElement("line", {x1, y1, x2, y2, class: cssClass});
  const text = (x, y, value, extra = {}) => svgElement("text", {x, y, ...extra}, value);

  const axes = svgElement("g", {"aria-hidden": "true"});
  for (const label of labels) {
    axes.append(line(x(label), plot.top, x(label), plot.bottom, "grid-line"));
    axes.append(text(x(label), plot.bottom + 26, displayNumber(label, 4), {"text-anchor": "middle"}));
  }
  for (const height of [0, .25, .5, .75, 1]) {
    axes.append(line(plot.left, y(height), plot.right, y(height), "grid-line"));
    axes.append(text(plot.left - 9, y(height) + 5, displayNumber(height, 2), {"text-anchor": "end"}));
  }
  axes.append(
    line(plot.left, plot.bottom, plot.right, plot.bottom, "axis-line"),
    line(plot.left, plot.top, plot.left, plot.bottom, "axis-line"),
    text((plot.left + plot.right) / 2, 374, "Uₓ [m/s]", {class: "axis-label", "text-anchor": "middle"}),
    text(0, 0, "y/H [–]", {class: "axis-label", "text-anchor": "middle", transform: "translate(17 167) rotate(-90)"}),
  );

  function curve(key, cssClass) {
    const vertices = points.map((point) => x(point[key]) + "," + y(point.y_over_H)).join(" ");
    return svgElement("polyline", {points: vertices, class: cssClass, "aria-hidden": "true"});
  }

  const guide = line(plot.left, 0, plot.right, 0, "guide");
  const calcMarker = svgElement("circle", {r: 3.5, class: "cfd-point"});
  const exactMarker = svgElement("circle", {r: 5, class: "exact-point"});
  const cursor = svgElement("g", {"aria-hidden": "true", "pointer-events": "none"});
  cursor.append(guide, exactMarker, calcMarker);
  svg.replaceChildren(axes, curve("Ux_CFD_m_s", "cfd"), curve("Ux_exact_at_centre_m_s", "exact"), cursor);

  let activeIndex = Math.floor((points.length - 1) / 2);
  function activate(index) {
    activeIndex = index;
    const point = points[index];
    const row = y(point.y_over_H);
    guide.setAttribute("y1", row);
    guide.setAttribute("y2", row);
    calcMarker.setAttribute("cx", x(point.Ux_CFD_m_s));
    calcMarker.setAttribute("cy", row);
    exactMarker.setAttribute("cx", x(point.Ux_exact_at_centre_m_s));
    exactMarker.setAttribute("cy", row);
    readout.textContent = "y/H " + displayNumber(point.y_over_H, 4) + " · 계산 "
      + metric(point.Ux_CFD_m_s, "m/s") + " · 이론 " + metric(point.Ux_exact_at_centre_m_s, "m/s");
  }

  svg.onpointermove = (event) => {
    const screen = svg.getScreenCTM();
    if (!screen) return;
    const pointer = svg.createSVGPoint();
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const height = (plot.bottom - pointer.matrixTransform(screen.inverse()).y) / (plot.bottom - plot.top);
    const index = points.reduce((nearest, point, candidate) =>
      Math.abs(point.y_over_H - height) < Math.abs(points[nearest].y_over_H - height) ? candidate : nearest, 0);
    if (activeIndex !== index) activate(index);
  };
  svg.onkeydown = (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = activeIndex + (event.key === "ArrowUp" ? 1 : -1);
    readout.setAttribute("aria-live", "polite");
    activate(Math.max(0, Math.min(points.length - 1, index)));
  };
  activate(activeIndex);
}

byId("log-select").addEventListener("change", (event) => {
  chosenLog = event.currentTarget.value;
  updateLog(currentRun, chosenLog);
});

byId("log-panel").addEventListener("toggle", () => {
  if (byId("log-panel").open) updateLog(currentRun, byId("log-select").value);
});

byId("run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("run-button");
  button.disabled = true;
  notification(byId("request-error"), "");
  connectionError = false;
  const ny = Number(new FormData(event.currentTarget).get("ny"));
  try {
    const run = await request("/api/runs", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ny}),
    });
    selectRun(run.id, "pushState");
    showRun(run);
    refresh();
  } catch (error) {
    notification(byId("request-error"), "케이스를 시작할 수 없습니다. " + error.message);
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("popstate", () => {
  selectRun(initialRun());
  refresh();
});

request("/api/environment").then(showEnvironment).catch((error) => {
  badge(byId("environment-badge"), "실행 환경 확인 실패", "error");
  byId("environment-caption").textContent = error.message;
});
refresh();

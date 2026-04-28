/* =========================================================================
   EvAU Madrid — app
   ========================================================================= */

const METRICAS = {
  nm:  { label: "Nota media",        cm: "ncm",  decimals: 2, suffix: "" },
  na:  { label: "Nota media aptos",  cm: "nacm", decimals: 2, suffix: "" },
  pa:  { label: "% aptos",           cm: "pacm", decimals: 1, suffix: "%" },
  np:  { label: "Nº presentados",    cm: null,   decimals: 0, suffix: "" },
};

const PALETA = [
  "#b32d2e", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e",
  "#17becf", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22",
];

const STATE = {
  rows: [],            // raw
  centros: new Map(),  // codigo → { meta, byCurso: Map }
  cursos: [],
  filters: {
    search: "",
    area: "",
    titularidad: "",
    curso: "",
    metrica: "nm",
  },
  sort: { key: "metric", dir: "desc" },
  selected: null,
  comparing: new Set(),
  detailMetric: "nm",
  charts: { detail: null, compare: null },
};

// --------------------------- INIT ---------------------------

document.addEventListener("DOMContentLoaded", () => {
  if (!window.DATA) {
    document.getElementById("meta").textContent = "No se han podido cargar los datos.";
    return;
  }
  STATE.rows = window.DATA.rows;
  STATE.cursos = window.DATA.meta.cursos.slice().sort();
  STATE.filters.curso = STATE.cursos[STATE.cursos.length - 1];
  STATE.detailMetric = "nm";

  agruparPorCentro();
  rellenarFiltros(window.DATA.meta);
  bindEvents();
  render();
});

function agruparPorCentro() {
  for (const r of STATE.rows) {
    if (!STATE.centros.has(r.c)) {
      STATE.centros.set(r.c, {
        meta: { c: r.c, n: r.n, t: r.t, tit: r.tit, mun: r.mun, a: r.a },
        byCurso: new Map(),
      });
    }
    STATE.centros.get(r.c).byCurso.set(r.curso, r);
  }
}

function rellenarFiltros(meta) {
  document.getElementById("meta").textContent =
    `${meta.n_centros_con_datos} centros con datos · ` +
    `${meta.cursos[0].replace("-", "/")} → ${meta.cursos[meta.cursos.length - 1].replace("-", "/")}`;

  const areas = [...new Set(STATE.rows.map(r => r.a))].sort();
  const sel = document.getElementById("area");
  for (const a of areas) sel.add(new Option(a, a));

  const tits = [...new Set(STATE.rows.map(r => r.tit))].sort();
  const selT = document.getElementById("titularidad");
  for (const t of tits) selT.add(new Option(t, t));

  const selC = document.getElementById("curso");
  for (const c of STATE.cursos) {
    const opt = new Option(c.replace("-", "/"), c);
    selC.add(opt);
  }
  selC.value = STATE.filters.curso;
}

function bindEvents() {
  document.getElementById("search").addEventListener("input", e => {
    STATE.filters.search = normalize(e.target.value);
    render();
  });
  document.getElementById("area").addEventListener("change", e => { STATE.filters.area = e.target.value; render(); });
  document.getElementById("titularidad").addEventListener("change", e => { STATE.filters.titularidad = e.target.value; render(); });
  document.getElementById("curso").addEventListener("change", e => { STATE.filters.curso = e.target.value; render(); });
  document.getElementById("metrica").addEventListener("change", e => { STATE.filters.metrica = e.target.value; render(); });
  document.getElementById("reset").addEventListener("click", () => {
    STATE.filters.search = "";
    STATE.filters.area = "";
    STATE.filters.titularidad = "";
    STATE.filters.metrica = "nm";
    document.getElementById("search").value = "";
    document.getElementById("area").value = "";
    document.getElementById("titularidad").value = "";
    document.getElementById("metrica").value = "nm";
    render();
  });

  document.querySelectorAll("thead th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (STATE.sort.key === k) {
        STATE.sort.dir = STATE.sort.dir === "asc" ? "desc" : "asc";
      } else {
        STATE.sort.key = k;
        // Por defecto: numéricos descendentes (más alto primero), salvo
        // "pos" que es ascendente (puesto 1 arriba).
        STATE.sort.dir = (k === "metric" || k === "delta") ? "desc" : "asc";
      }
      render();
    });
  });

  document.getElementById("compare-show").addEventListener("click", openCompareDialog);
  document.getElementById("compare-clear").addEventListener("click", () => {
    STATE.comparing.clear();
    updateCompareBar();
    render();
  });
  document.getElementById("compare-close").addEventListener("click", () => {
    document.getElementById("compare-dialog").close();
  });
  document.querySelectorAll("#compare-dialog .metric-tabs button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#compare-dialog .metric-tabs button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      drawCompareChart(b.dataset.metric);
    });
  });
}

// --------------------------- FILTRO + RENDER ---------------------------

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function filtrarCentros() {
  const f = STATE.filters;
  const result = [];
  for (const c of STATE.centros.values()) {
    if (f.area && c.meta.a !== f.area) continue;
    if (f.titularidad && c.meta.tit !== f.titularidad) continue;
    if (f.search) {
      const haystack = normalize(c.meta.n + " " + c.meta.mun);
      if (!haystack.includes(f.search)) continue;
    }
    result.push(c);
  }
  return result;
}

function valorMetrica(centro, curso, metrica) {
  const r = centro.byCurso.get(curso);
  if (!r) return null;
  return r[metrica];
}

// Rankings globales (todos los centros con datos), cacheados por curso+métrica.
const rankingCache = new Map();
function rankingGlobal(curso, metrica) {
  const key = curso + "|" + metrica;
  if (rankingCache.has(key)) return rankingCache.get(key);

  const filas = [];
  for (const c of STATE.centros.values()) {
    const v = valorMetrica(c, curso, metrica);
    if (v != null) filas.push({ codigo: c.meta.c, v });
  }
  // Para todas las métricas (nm, na, pa, np), mayor = mejor → rank 1 al máximo.
  filas.sort((a, b) => b.v - a.v);

  const rank = new Map();
  // Empates: damos el mismo rank y saltamos los siguientes (estilo "1, 2, 2, 4").
  let i = 0;
  while (i < filas.length) {
    let j = i;
    while (j + 1 < filas.length && filas[j + 1].v === filas[i].v) j++;
    for (let k = i; k <= j; k++) rank.set(filas[k].codigo, i + 1);
    i = j + 1;
  }
  rankingCache.set(key, rank);
  return rank;
}

function cursoAnterior(curso) {
  const i = STATE.cursos.indexOf(curso);
  return i > 0 ? STATE.cursos[i - 1] : null;
}

// Devuelve { delta, rankPrev, rankNow }.
//   delta  ∈ número | "new" (sin datos curso anterior) | null (sin datos actuales o sin curso anterior)
//   delta > 0 = subió de puesto, delta < 0 = bajó.
function deltaRanking(codigo, curso, metrica) {
  const rNow = rankingGlobal(curso, metrica).get(codigo) ?? null;
  const prev = cursoAnterior(curso);
  if (!prev) return { delta: null, rankPrev: null, rankNow: rNow };
  const rPrev = rankingGlobal(prev, metrica).get(codigo) ?? null;
  if (rNow == null) return { delta: null, rankPrev: rPrev, rankNow: null };
  if (rPrev == null) return { delta: "new", rankPrev: null, rankNow: rNow };
  return { delta: rPrev - rNow, rankPrev: rPrev, rankNow: rNow };
}

function ordenar(centros) {
  const { key, dir } = STATE.sort;
  const m = STATE.filters.metrica;
  const k = STATE.filters.curso;
  const sign = dir === "asc" ? 1 : -1;

  const ranks = rankingGlobal(k, m);

  centros.sort((a, b) => {
    let va, vb;
    if (key === "metric") {
      va = valorMetrica(a, k, m);
      vb = valorMetrica(b, k, m);
    } else if (key === "pos") {
      // Puesto global: 1, 2, 3... null al final siempre.
      va = ranks.get(a.meta.c) ?? null;
      vb = ranks.get(b.meta.c) ?? null;
    } else if (key === "delta") {
      const da = deltaRanking(a.meta.c, k, m).delta;
      const db = deltaRanking(b.meta.c, k, m).delta;
      // "new" se trata como muy alto positivo (recién entrado en el ranking).
      // null va al final.
      va = da === "new" ? Number.POSITIVE_INFINITY : (typeof da === "number" ? da : null);
      vb = db === "new" ? Number.POSITIVE_INFINITY : (typeof db === "number" ? db : null);
    } else {
      va = (a.meta[key] || "").toString().toLowerCase();
      vb = (b.meta[key] || "").toString().toLowerCase();
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return sign * (va - vb);
    return sign * (va < vb ? -1 : va > vb ? 1 : 0);
  });
  return centros;
}

function render() {
  // sort header indicators
  document.querySelectorAll("thead th").forEach(th => {
    th.classList.remove("active", "asc", "desc");
  });
  const activeTh = document.querySelector(`thead th[data-sort="${STATE.sort.key}"]`);
  if (activeTh) activeTh.classList.add("active", STATE.sort.dir);

  // metric column header
  const ths = document.querySelectorAll("thead th[data-sort]");
  ths.forEach(th => {
    if (th.dataset.sort === "metric") th.textContent = METRICAS[STATE.filters.metrica].label;
  });

  document.getElementById("curso-label").textContent =
    `Curso ${STATE.filters.curso.replace("-", "/")} · ${METRICAS[STATE.filters.metrica].label}`;

  const filtrados = ordenar(filtrarCentros());
  document.getElementById("result-count").textContent =
    `${filtrados.length} centro${filtrados.length === 1 ? "" : "s"}`;

  renderTable(filtrados);
  updateCompareBar();
}

function fmt(v, m) {
  if (v == null) return "—";
  const cfg = METRICAS[m];
  return v.toFixed(cfg.decimals).replace(".", ",") + cfg.suffix;
}

function renderTable(centros) {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";

  if (!centros.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Ningún centro con esos filtros.</td></tr>`;
    return;
  }

  const k = STATE.filters.curso;
  const m = STATE.filters.metrica;
  const cmField = METRICAS[m].cm;
  const prev = cursoAnterior(k);
  const ranksGlobales = rankingGlobal(k, m);

  const frag = document.createDocumentFragment();
  centros.forEach((c, i) => {
    const v  = valorMetrica(c, k, m);
    const vc = cmField ? valorMetrica(c, k, cmField) : null;
    const rankGlobal = ranksGlobales.get(c.meta.c);

    const tr = document.createElement("tr");
    tr.dataset.codigo = c.meta.c;
    if (STATE.selected === c.meta.c) tr.classList.add("selected");

    const isComparing = STATE.comparing.has(c.meta.c);

    let cmDeltaHtml = "";
    if (v != null && vc != null) {
      const d = v - vc;
      const sign = d > 0 ? "+" : "";
      const cls = d > 0 ? "good" : d < 0 ? "bad" : "";
      cmDeltaHtml = `<span class="delta ${cls}">${sign}${d.toFixed(METRICAS[m].decimals).replace(".", ",")}</span>`;
    }

    // Delta de posición en el ranking global vs curso anterior
    const dr = deltaRanking(c.meta.c, k, m);
    let rankDeltaHtml = `<span class="rank-delta none">—</span>`;
    let rankDeltaTitle = prev ? `Sin posición en ${prev.replace("-", "/")}` : "No hay curso anterior";
    if (dr.delta === "new") {
      rankDeltaHtml = `<span class="rank-delta new" title="Nuevo en el ranking · puesto ${dr.rankNow}">●&nbsp;nuevo</span>`;
    } else if (typeof dr.delta === "number") {
      if (dr.delta > 0) {
        rankDeltaHtml = `<span class="rank-delta up">▲ ${dr.delta}</span>`;
      } else if (dr.delta < 0) {
        rankDeltaHtml = `<span class="rank-delta down">▼ ${-dr.delta}</span>`;
      } else {
        rankDeltaHtml = `<span class="rank-delta same">●</span>`;
      }
      rankDeltaTitle = `Puesto ${dr.rankNow} (antes ${dr.rankPrev}, en ${prev.replace("-", "/")})`;
    }

    tr.innerHTML = `
      <td class="rank" title="Puesto en el ranking global por ${escapeAttr(METRICAS[m].label.toLowerCase())}">${rankGlobal ?? "—"}</td>
      <td class="num rank-delta-cell" title="${escapeAttr(rankDeltaTitle)}">${rankDeltaHtml}</td>
      <td class="center-name">
        <span class="add-compare ${isComparing ? "on" : ""}" title="Añadir a comparativa">${isComparing ? "✓" : "+"}</span>
        ${escapeHtml(c.meta.n)}
      </td>
      <td>${escapeHtml(c.meta.mun || "—")}</td>
      <td>${escapeHtml(c.meta.a || "")}</td>
      <td>${escapeHtml(c.meta.tit || "")}</td>
      <td class="num">${fmt(v, m)}</td>
      <td class="num">${vc != null ? fmt(vc, m) + " " + cmDeltaHtml : "—"}</td>
    `;

    tr.addEventListener("click", e => {
      if (e.target.classList.contains("add-compare")) {
        toggleCompare(c.meta.c);
        e.stopPropagation();
        return;
      }
      seleccionarCentro(c.meta.c);
    });

    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
const escapeAttr = escapeHtml;

// --------------------------- DETALLE ---------------------------

function seleccionarCentro(codigo) {
  STATE.selected = codigo;
  STATE.detailMetric = STATE.filters.metrica;
  renderDetail();
  // sync row highlight
  document.querySelectorAll("tbody tr").forEach(tr => {
    tr.classList.toggle("selected", tr.dataset.codigo === codigo);
  });
}

function renderDetail() {
  const codigo = STATE.selected;
  if (!codigo) return;
  const centro = STATE.centros.get(codigo);
  if (!centro) return;

  const isComparing = STATE.comparing.has(codigo);
  const cursos = STATE.cursos;

  const detail = document.getElementById("detail");
  detail.innerHTML = `
    <h2>${escapeHtml(centro.meta.n)}</h2>
    <div class="center-meta">
      <span><strong>${escapeHtml(centro.meta.t || "—")}</strong></span>
      <span>${escapeHtml(centro.meta.tit || "")}</span>
      <span>${escapeHtml(centro.meta.mun || "")}, ${escapeHtml(centro.meta.a || "")}</span>
      <span class="codigo">cód. ${centro.meta.c}</span>
    </div>
    <div class="metric-tabs detail-metric-tabs" role="tablist">
      ${Object.entries(METRICAS).map(([k, v]) =>
        `<button data-metric="${k}" class="${k === STATE.detailMetric ? "active" : ""}">${v.label}</button>`
      ).join("")}
    </div>
    <div class="chart-host"><canvas id="detail-chart"></canvas></div>
    <table>
      <thead>
        <tr>
          <th>Curso</th>
          <th class="num">Nota media</th>
          <th class="num">Nota CM</th>
          <th class="num">Nº pres.</th>
          <th class="num">% aptos</th>
          <th class="num">Nota aptos</th>
        </tr>
      </thead>
      <tbody>
        ${cursos.map(c => {
          const r = centro.byCurso.get(c);
          if (!r) return `<tr><td>${c.replace("-", "/")}</td><td colspan="5" class="num" style="color:var(--text-faint)">—</td></tr>`;
          return `<tr>
            <td>${c.replace("-", "/")}</td>
            <td class="num">${fmt(r.nm, "nm")}</td>
            <td class="num">${fmt(r.ncm, "nm")}</td>
            <td class="num">${fmt(r.np, "np")}</td>
            <td class="num">${fmt(r.pa, "pa")}</td>
            <td class="num">${fmt(r.na, "na")}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    <button class="add-compare-cta ${isComparing ? "on" : ""}" id="detail-compare-btn">
      ${isComparing ? "✓ En comparativa" : "+ Añadir a comparativa"}
    </button>
  `;

  detail.querySelectorAll(".detail-metric-tabs button").forEach(b => {
    b.addEventListener("click", () => {
      STATE.detailMetric = b.dataset.metric;
      detail.querySelectorAll(".detail-metric-tabs button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      drawDetailChart();
    });
  });
  detail.querySelector("#detail-compare-btn").addEventListener("click", () => {
    toggleCompare(codigo);
    renderDetail();
    render();
  });

  drawDetailChart();
}

function drawDetailChart() {
  const codigo = STATE.selected;
  const centro = STATE.centros.get(codigo);
  const m = STATE.detailMetric;
  const cm = METRICAS[m].cm;
  const ctx = document.getElementById("detail-chart");
  if (!ctx) return;

  const labels = STATE.cursos.map(c => c.replace("-", "/"));
  const dataCentro = STATE.cursos.map(c => {
    const r = centro.byCurso.get(c);
    return r ? r[m] : null;
  });
  const datasets = [{
    label: "Centro",
    data: dataCentro,
    borderColor: "#b32d2e",
    backgroundColor: "#b32d2e22",
    borderWidth: 2.5,
    tension: .25,
    pointRadius: 4,
    pointHoverRadius: 6,
    spanGaps: true,
  }];
  if (cm) {
    datasets.push({
      label: "Comunidad de Madrid",
      data: STATE.cursos.map(c => {
        const r = centro.byCurso.get(c);
        return r ? r[cm] : null;
      }),
      borderColor: "#7a8094",
      backgroundColor: "transparent",
      borderWidth: 1.8,
      borderDash: [4, 4],
      tension: .25,
      pointRadius: 3,
      spanGaps: true,
    });
  }

  if (STATE.charts.detail) STATE.charts.detail.destroy();
  STATE.charts.detail = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: chartOptions(m),
  });
}

// --------------------------- COMPARAR ---------------------------

function toggleCompare(codigo) {
  if (STATE.comparing.has(codigo)) STATE.comparing.delete(codigo);
  else STATE.comparing.add(codigo);
  updateCompareBar();
  render();
  if (STATE.selected === codigo) renderDetail();
}

function updateCompareBar() {
  const bar = document.getElementById("compare-bar");
  const n = STATE.comparing.size;
  if (n === 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  document.getElementById("compare-text").textContent =
    `Comparando ${n} centro${n === 1 ? "" : "s"}`;
}

function openCompareDialog() {
  if (STATE.comparing.size === 0) return;
  const dialog = document.getElementById("compare-dialog");
  // reset metric tabs to default (nm)
  document.querySelectorAll("#compare-dialog .metric-tabs button").forEach(b => {
    b.classList.toggle("active", b.dataset.metric === "nm");
  });
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  // chart needs to be drawn AFTER dialog is visible (canvas size)
  requestAnimationFrame(() => drawCompareChart("nm"));
}

function drawCompareChart(metric) {
  const ctx = document.getElementById("compare-chart");
  if (!ctx) return;
  const labels = STATE.cursos.map(c => c.replace("-", "/"));
  const datasets = [];
  let i = 0;
  for (const codigo of STATE.comparing) {
    const centro = STATE.centros.get(codigo);
    if (!centro) continue;
    datasets.push({
      label: centro.meta.n,
      data: STATE.cursos.map(c => {
        const r = centro.byCurso.get(c);
        return r ? r[metric] : null;
      }),
      borderColor: PALETA[i % PALETA.length],
      backgroundColor: PALETA[i % PALETA.length] + "22",
      borderWidth: 2.2,
      tension: .25,
      pointRadius: 4,
      spanGaps: true,
    });
    i++;
  }
  // CM como línea de referencia (gris discontinuo)
  const cmField = METRICAS[metric].cm;
  if (cmField) {
    // tomamos la CM de cualquier centro (es la misma para todos)
    let cmData = STATE.cursos.map(c => null);
    for (const codigo of STATE.comparing) {
      const centro = STATE.centros.get(codigo);
      if (!centro) continue;
      cmData = STATE.cursos.map(c => {
        const r = centro.byCurso.get(c);
        return r ? r[cmField] : null;
      });
      if (cmData.some(v => v != null)) break;
    }
    datasets.push({
      label: "Comunidad de Madrid",
      data: cmData,
      borderColor: "#7a8094",
      borderWidth: 1.6,
      borderDash: [4, 4],
      tension: .25,
      pointRadius: 0,
      spanGaps: true,
    });
  }

  if (STATE.charts.compare) STATE.charts.compare.destroy();
  STATE.charts.compare = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: chartOptions(metric, { legend: true }),
  });
}

// --------------------------- CHART OPTIONS ---------------------------

function chartOptions(metric, opts = {}) {
  const cfg = METRICAS[metric];
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const grid = dark ? "#2a313e" : "#e3e6ec";
  const tick = dark ? "#a8b0c2" : "#5a6275";
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: opts.legend ?? true,
        position: "bottom",
        labels: { color: tick, boxWidth: 14, font: { size: 12 } },
      },
      tooltip: {
        callbacks: {
          label: ctx => {
            const v = ctx.parsed.y;
            if (v == null) return ctx.dataset.label + ": —";
            return ctx.dataset.label + ": " + v.toFixed(cfg.decimals).replace(".", ",") + cfg.suffix;
          },
        },
      },
    },
    scales: {
      x: { grid: { color: grid }, ticks: { color: tick } },
      y: {
        grid: { color: grid },
        ticks: {
          color: tick,
          callback: v => v.toFixed(cfg.decimals).replace(".", ",") + cfg.suffix,
        },
      },
    },
  };
}

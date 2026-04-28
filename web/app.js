/* =========================================================================
   EvAU Madrid — app
   Módulo ES; cargado vía <script type="module">. Modo estricto implícito.
   ========================================================================= */

const METRICAS = Object.freeze({
  nm:  { label: "Nota media",        cm: "ncm",  decimals: 2, suffix: "" },
  na:  { label: "Nota media aptos",  cm: "nacm", decimals: 2, suffix: "" },
  pa:  { label: "% aptos",           cm: "pacm", decimals: 1, suffix: "%" },
  np:  { label: "Nº presentados",    cm: null,   decimals: 0, suffix: "" },
});

const PALETA = Object.freeze([
  "#b32d2e", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e",
  "#17becf", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22",
]);

const COLLATOR_ES = new Intl.Collator("es", { sensitivity: "base", numeric: true });
const SEARCH_DEBOUNCE_MS = 120;

// ---------------------------------------------------------------------------
// Referencias DOM cacheadas (las usamos en muchos sitios — mejor leerlas una vez).
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const DOM = {
  meta:        $("meta"),
  search:      $("search"),
  area:        $("area"),
  titularidad: $("titularidad"),
  curso:       $("curso"),
  metrica:     $("metrica"),
  reset:       $("reset"),
  resultCount: $("result-count"),
  cursoLabel:  $("curso-label"),
  thead:       document.querySelector("thead"),
  tbody:       $("tbody"),
  detail:        $("detail"),
  detailBody:    $("detail-body"),
  detailClose:   $("detail-close"),
  detailBackdrop:$("detail-backdrop"),
  compareBar:  $("compare-bar"),
  compareText: $("compare-text"),
  compareShow: $("compare-show"),
  compareClear:$("compare-clear"),
  compareClose:$("compare-close"),
  compareDialog: $("compare-dialog"),
};

// ---------------------------------------------------------------------------
// Estado global. Mutable, encapsulado en un único objeto para facilitar el
// rastreo de quién lo modifica.
// ---------------------------------------------------------------------------
const STATE = {
  rows: [],
  centros: new Map(),  // codigo → { meta, byCurso: Map<curso, row> }
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
  detailMetrica: "nm",
  charts: { detail: null, compare: null },
};

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  if (!window.DATA) {
    DOM.meta.textContent = "No se han podido cargar los datos.";
    return;
  }
  STATE.rows = window.DATA.rows;
  STATE.cursos = window.DATA.meta.cursos.slice().sort();
  STATE.filters.curso = STATE.cursos.at(-1) ?? "";
  STATE.detailMetrica = "nm";

  agruparPorCentro();
  rellenarFiltros(window.DATA.meta);
  bindEvents();
  render();
});

function agruparPorCentro() {
  for (const r of STATE.rows) {
    if (!STATE.centros.has(r.c)) {
      STATE.centros.set(r.c, {
        meta: {
          c: r.c, n: r.n, t: r.t, tit: r.tit, mun: r.mun, a: r.a,
          dir: r.dir || "",
        },
        byCurso: new Map(),
      });
    }
    STATE.centros.get(r.c).byCurso.set(r.curso, r);
  }
}

function rellenarFiltros(meta) {
  const primero = meta.cursos[0]?.replace("-", "/") ?? "?";
  const ultimo  = meta.cursos.at(-1)?.replace("-", "/") ?? "?";
  DOM.meta.textContent = `${meta.n_centros_con_datos} centros con datos · ${primero} → ${ultimo}`;

  for (const a of [...new Set(STATE.rows.map(r => r.a))].sort(COLLATOR_ES.compare)) {
    DOM.area.add(new Option(a, a));
  }
  for (const t of [...new Set(STATE.rows.map(r => r.tit))].sort(COLLATOR_ES.compare)) {
    DOM.titularidad.add(new Option(t, t));
  }
  for (const c of STATE.cursos) {
    DOM.curso.add(new Option(c.replace("-", "/"), c));
  }
  DOM.curso.value = STATE.filters.curso;
}

// ---------------------------------------------------------------------------
// EVENTOS
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function bindEvents() {
  const onSearch = debounce(value => {
    STATE.filters.search = normalize(value);
    render();
  }, SEARCH_DEBOUNCE_MS);
  DOM.search.addEventListener("input", e => onSearch(e.target.value));

  DOM.area.addEventListener("change",        e => { STATE.filters.area = e.target.value;        render(); });
  DOM.titularidad.addEventListener("change", e => { STATE.filters.titularidad = e.target.value; render(); });
  DOM.curso.addEventListener("change",       e => { STATE.filters.curso = e.target.value;       render(); });
  DOM.metrica.addEventListener("change",     e => { STATE.filters.metrica = e.target.value;     render(); });

  DOM.reset.addEventListener("click", () => {
    STATE.filters.search = "";
    STATE.filters.area = "";
    STATE.filters.titularidad = "";
    STATE.filters.metrica = "nm";
    DOM.search.value = "";
    DOM.area.value = "";
    DOM.titularidad.value = "";
    DOM.metrica.value = "nm";
    render();
  });

  DOM.thead.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => onSortHeaderClick(th.dataset.sort));
    th.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSortHeaderClick(th.dataset.sort);
      }
    });
    th.setAttribute("tabindex", "0");
    th.setAttribute("role", "columnheader");
    th.setAttribute("aria-sort", "none");
  });

  DOM.detailClose.addEventListener("click", cerrarDetalle);
  DOM.detailBackdrop.addEventListener("click", cerrarDetalle);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && DOM.detail.classList.contains("open")) {
      cerrarDetalle();
    }
  });

  DOM.compareShow.addEventListener("click", openCompareDialog);
  DOM.compareClear.addEventListener("click", () => {
    STATE.comparing.clear();
    updateCompareBar();
    render();
  });
  DOM.compareClose.addEventListener("click", () => DOM.compareDialog.close());

  DOM.compareDialog.querySelectorAll(".metric-tabs button").forEach(b => {
    b.addEventListener("click", () => {
      DOM.compareDialog.querySelectorAll(".metric-tabs button")
        .forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      drawCompareChart(b.dataset.metric);
    });
  });
}

function onSortHeaderClick(key) {
  if (STATE.sort.key === key) {
    STATE.sort.dir = STATE.sort.dir === "asc" ? "desc" : "asc";
  } else {
    STATE.sort.key = key;
    // Default: numéricos descendentes; "pos" y textuales ascendentes.
    STATE.sort.dir = (key === "metric" || key === "delta") ? "desc" : "asc";
  }
  render();
}

// ---------------------------------------------------------------------------
// FILTRADO + ORDEN
// ---------------------------------------------------------------------------

function normalize(s) {
  // Strip combining diacritical marks (U+0300..U+036F).
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
  return r ? r[metrica] : null;
}

// Rankings globales (todos los centros con datos), cacheados por curso+métrica.
const rankingCache = new Map();
function rankingGlobal(curso, metrica) {
  const key = curso + "|" + metrica;
  const cached = rankingCache.get(key);
  if (cached) return cached;

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
      va = ranks.get(a.meta.c) ?? null;
      vb = ranks.get(b.meta.c) ?? null;
    } else if (key === "delta") {
      const da = deltaRanking(a.meta.c, k, m).delta;
      const db = deltaRanking(b.meta.c, k, m).delta;
      // "new" se trata como muy alto positivo (recién entrado en el ranking).
      va = da === "new" ? Number.POSITIVE_INFINITY : (typeof da === "number" ? da : null);
      vb = db === "new" ? Number.POSITIVE_INFINITY : (typeof db === "number" ? db : null);
    } else {
      // Columnas textuales: ordenamos con localeCompare español.
      const sa = (a.meta[key] || "").toString();
      const sb = (b.meta[key] || "").toString();
      return sign * COLLATOR_ES.compare(sa, sb);
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sign * (va - vb);
  });
  return centros;
}

// ---------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------

function render() {
  // Indicadores de orden y aria-sort en la cabecera.
  DOM.thead.querySelectorAll("th").forEach(th => {
    th.classList.remove("active", "asc", "desc");
    if (th.hasAttribute("aria-sort")) th.setAttribute("aria-sort", "none");
  });
  const activeTh = DOM.thead.querySelector(`th[data-sort="${STATE.sort.key}"]`);
  if (activeTh) {
    activeTh.classList.add("active", STATE.sort.dir);
    activeTh.setAttribute("aria-sort", STATE.sort.dir === "asc" ? "ascending" : "descending");
  }

  // Etiqueta dinámica de la columna "Métrica".
  const metricTh = DOM.thead.querySelector('th[data-sort="metric"]');
  if (metricTh) metricTh.textContent = METRICAS[STATE.filters.metrica].label;

  DOM.cursoLabel.textContent =
    `Curso ${STATE.filters.curso.replace("-", "/")} · ${METRICAS[STATE.filters.metrica].label}`;

  const filtrados = ordenar(filtrarCentros());
  DOM.resultCount.textContent =
    `${filtrados.length} centro${filtrados.length === 1 ? "" : "s"}`;

  renderTable(filtrados);
  updateCompareBar();
}

function fmt(v, m) {
  if (v == null) return "—";
  const cfg = METRICAS[m];
  return v.toFixed(cfg.decimals).replace(".", ",") + cfg.suffix;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c])
  );
}
const escapeAttr = escapeHtml;

// URL de OpenStreetMap para un centro. Si tenemos `dir` (calle, nº, CP,
// municipio), la usamos; si no, hacemos una búsqueda fallback con
// "nombre del centro, municipio, Madrid".
function osmUrl(centro) {
  const query = centro.dir && centro.dir.trim()
    ? centro.dir
    : [centro.n, centro.mun, "Madrid"].filter(Boolean).join(", ");
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

const PIN_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2C7.58 2 4 5.58 4 10c0 5.25 7.13 11.6 7.43 11.87a.85.85 0 0 0 1.14 0C12.87 21.6 20 15.25 20 10c0-4.42-3.58-8-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/></svg>`;

function renderTable(centros) {
  DOM.tbody.innerHTML = "";

  if (!centros.length) {
    DOM.tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Ningún centro con esos filtros.</td></tr>`;
    return;
  }

  const k = STATE.filters.curso;
  const m = STATE.filters.metrica;
  const cmField = METRICAS[m].cm;
  const prev = cursoAnterior(k);
  const ranksGlobales = rankingGlobal(k, m);

  const frag = document.createDocumentFragment();
  centros.forEach(c => {
    const v  = valorMetrica(c, k, m);
    const vc = cmField ? valorMetrica(c, k, cmField) : null;
    const rankGlobal = ranksGlobales.get(c.meta.c);

    const tr = document.createElement("tr");
    tr.dataset.codigo = c.meta.c;
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `Ver detalle del centro ${c.meta.n}`);
    if (STATE.selected === c.meta.c) tr.classList.add("selected");

    const isComparing = STATE.comparing.has(c.meta.c);

    let cmDeltaHtml = "";
    if (v != null && vc != null) {
      const d = v - vc;
      const signo = d > 0 ? "+" : "";
      const cls = d > 0 ? "good" : d < 0 ? "bad" : "";
      cmDeltaHtml = `<span class="delta ${cls}">${signo}${d.toFixed(METRICAS[m].decimals).replace(".", ",")}</span>`;
    }

    // Δ de posición en el ranking global vs curso anterior.
    const dr = deltaRanking(c.meta.c, k, m);
    let rankDeltaHtml = `<span class="rank-delta none">—</span>`;
    let rankDeltaTitle = prev ? `Sin posición en ${prev.replace("-", "/")}` : "No hay curso anterior";
    if (dr.delta === "new") {
      rankDeltaHtml = `<span class="rank-delta new" title="Nuevo en el ranking · puesto ${dr.rankNow}">●&nbsp;nuevo</span>`;
    } else if (typeof dr.delta === "number") {
      if (dr.delta > 0)      rankDeltaHtml = `<span class="rank-delta up">▲ ${dr.delta}</span>`;
      else if (dr.delta < 0) rankDeltaHtml = `<span class="rank-delta down">▼ ${-dr.delta}</span>`;
      else                   rankDeltaHtml = `<span class="rank-delta same">●</span>`;
      rankDeltaTitle = `Puesto ${dr.rankNow} (antes ${dr.rankPrev}, en ${prev.replace("-", "/")})`;
    }

    const direccionTitle = c.meta.dir
      ? `Ver en OpenStreetMap · ${c.meta.dir}`
      : `Buscar "${c.meta.n}" en OpenStreetMap`;

    tr.innerHTML = `
      <td class="rank" title="Puesto en el ranking global por ${escapeAttr(METRICAS[m].label.toLowerCase())}">${rankGlobal ?? "—"}</td>
      <td class="num rank-delta-cell" title="${escapeAttr(rankDeltaTitle)}">${rankDeltaHtml}</td>
      <td class="center-name">
        <div class="center-name-row">
          <span class="row-actions">
            <span class="add-compare ${isComparing ? "on" : ""}"
                  role="button" tabindex="0"
                  aria-label="${isComparing ? "Quitar de la comparativa" : "Añadir a la comparativa"}"
                  aria-pressed="${isComparing}">${isComparing ? "✓" : "+"}</span>
            <a class="map-link"
               href="${escapeAttr(osmUrl(c.meta))}"
               target="_blank" rel="noopener noreferrer"
               title="${escapeAttr(direccionTitle)}"
               aria-label="${escapeAttr(direccionTitle)}">${PIN_SVG}</a>
          </span>
          <span class="center-name-text">${escapeHtml(c.meta.n)}</span>
        </div>
      </td>
      <td>${escapeHtml(c.meta.mun || "—")}</td>
      <td>${escapeHtml(c.meta.a || "")}</td>
      <td>${escapeHtml(c.meta.tit || "")}</td>
      <td class="num">${fmt(v, m)}</td>
      <td class="num">${vc != null ? fmt(vc, m) + " " + cmDeltaHtml : "—"}</td>
    `;

    tr.addEventListener("click", e => onRowActivate(e, c.meta.c));
    tr.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onRowActivate(e, c.meta.c);
      }
    });

    frag.appendChild(tr);
  });
  DOM.tbody.appendChild(frag);
}

function onRowActivate(e, codigo) {
  // El botón `+` y el enlace de OSM están dentro del <tr>; usamos closest
  // para soportar clics sobre cualquier descendiente (texto, SVG del icono).
  if (e.target.closest(".add-compare")) {
    toggleCompare(codigo);
    e.stopPropagation();
    return;
  }
  // Si el clic fue sobre el enlace OSM, dejamos que el navegador siga el href
  // (target="_blank") y NO abrimos el detalle.
  if (e.target.closest(".map-link")) {
    return;
  }
  seleccionarCentro(codigo);
}

// ---------------------------------------------------------------------------
// DETALLE
// ---------------------------------------------------------------------------

function seleccionarCentro(codigo) {
  STATE.selected = codigo;
  STATE.detailMetrica = STATE.filters.metrica;
  renderDetail();
  // En móvil el panel es un bottom sheet con backdrop; lo abrimos al seleccionar.
  DOM.detail.classList.add("open");
  DOM.detailBackdrop.hidden = false;
  // Sincroniza el resaltado de la fila seleccionada.
  DOM.tbody.querySelectorAll("tr").forEach(tr => {
    tr.classList.toggle("selected", tr.dataset.codigo === codigo);
  });
}

function cerrarDetalle() {
  STATE.selected = null;
  DOM.detail.classList.remove("open");
  DOM.detailBackdrop.hidden = true;
  DOM.tbody.querySelectorAll("tr.selected").forEach(tr => tr.classList.remove("selected"));
  // Restaurar el placeholder por si el usuario está en escritorio (donde el
  // panel sigue ocupando su sitio en el grid).
  DOM.detailBody.innerHTML = `
    <div class="detail-empty">
      <p>Selecciona un centro de la lista para ver la evolución de sus notas a lo largo de los cursos.</p>
      <p class="hint">Sugerencia: pulsa el botón <strong>+</strong> de varias filas para superponerlas en el gráfico.</p>
    </div>
  `;
  // Liberar el chart anterior si existía.
  if (STATE.charts.detail) {
    try { STATE.charts.detail.destroy(); } catch { /* nada */ }
    STATE.charts.detail = null;
  }
}

function renderDetail() {
  const codigo = STATE.selected;
  if (!codigo) return;
  const centro = STATE.centros.get(codigo);
  if (!centro) return;

  const isComparing = STATE.comparing.has(codigo);
  const cursos = STATE.cursos;

  const direccionTitle = centro.meta.dir
    ? `Ver en OpenStreetMap · ${centro.meta.dir}`
    : `Buscar "${centro.meta.n}" en OpenStreetMap`;
  const direccionTexto = centro.meta.dir || `${centro.meta.mun}, ${centro.meta.a}`;

  DOM.detailBody.innerHTML = `
    <h2>${escapeHtml(centro.meta.n)}</h2>
    <div class="center-meta">
      <span><strong>${escapeHtml(centro.meta.t || "—")}</strong></span>
      <span>${escapeHtml(centro.meta.tit || "")}</span>
      <a class="map-link map-link-text"
         href="${escapeAttr(osmUrl(centro.meta))}"
         target="_blank" rel="noopener noreferrer"
         title="${escapeAttr(direccionTitle)}">${PIN_SVG}<span>${escapeHtml(direccionTexto)}</span></a>
      <span class="codigo">cód. ${escapeHtml(centro.meta.c)}</span>
    </div>
    <div class="metric-tabs detail-metric-tabs" role="tablist">
      ${Object.entries(METRICAS).map(([k, v]) =>
        `<button type="button" data-metric="${k}" class="${k === STATE.detailMetrica ? "active" : ""}">${v.label}</button>`
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
    <button type="button" class="add-compare-cta ${isComparing ? "on" : ""}" id="detail-compare-btn"
            aria-pressed="${isComparing}">
      ${isComparing ? "✓ En comparativa" : "+ Añadir a comparativa"}
    </button>
  `;

  DOM.detailBody.querySelectorAll(".detail-metric-tabs button").forEach(b => {
    b.addEventListener("click", () => {
      STATE.detailMetrica = b.dataset.metric;
      DOM.detailBody.querySelectorAll(".detail-metric-tabs button")
        .forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      drawDetailChart();
    });
  });
  DOM.detailBody.querySelector("#detail-compare-btn").addEventListener("click", () => {
    toggleCompare(codigo);
    renderDetail();
    render();
  });

  drawDetailChart();
}

function drawDetailChart() {
  const codigo = STATE.selected;
  const centro = STATE.centros.get(codigo);
  const m = STATE.detailMetrica;
  const cm = METRICAS[m].cm;
  const ctx = $("detail-chart");
  if (!ctx || !centro) return;

  const labels = STATE.cursos.map(c => c.replace("-", "/"));
  const datasets = [{
    label: "Centro",
    data: STATE.cursos.map(c => {
      const r = centro.byCurso.get(c);
      return r ? r[m] : null;
    }),
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

  STATE.charts.detail = renderChart(ctx, STATE.charts.detail, { labels, datasets }, m);
}

// ---------------------------------------------------------------------------
// COMPARAR
// ---------------------------------------------------------------------------

function toggleCompare(codigo) {
  if (STATE.comparing.has(codigo)) STATE.comparing.delete(codigo);
  else STATE.comparing.add(codigo);
  updateCompareBar();
  render();
  if (STATE.selected === codigo) renderDetail();
}

function updateCompareBar() {
  const n = STATE.comparing.size;
  if (n === 0) {
    DOM.compareBar.classList.add("hidden");
    return;
  }
  DOM.compareBar.classList.remove("hidden");
  DOM.compareText.textContent = `Comparando ${n} centro${n === 1 ? "" : "s"}`;
}

function openCompareDialog() {
  if (STATE.comparing.size === 0) return;
  // Reset metric tabs to default (nm).
  DOM.compareDialog.querySelectorAll(".metric-tabs button")
    .forEach(b => b.classList.toggle("active", b.dataset.metric === "nm"));

  if (typeof DOM.compareDialog.showModal === "function") DOM.compareDialog.showModal();
  else DOM.compareDialog.setAttribute("open", "");

  // El chart necesita pintarse DESPUÉS de que el dialog sea visible (canvas size).
  requestAnimationFrame(() => drawCompareChart("nm"));
}

function drawCompareChart(metric) {
  const ctx = $("compare-chart");
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

  // CM como línea de referencia (gris discontinuo). Es la misma para todos los
  // centros, así que basta con tomarla del primero que la tenga.
  const cmField = METRICAS[metric].cm;
  if (cmField) {
    let cmData = STATE.cursos.map(() => null);
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

  STATE.charts.compare = renderChart(ctx, STATE.charts.compare, { labels, datasets }, metric);
}

// ---------------------------------------------------------------------------
// CHART (helper común con manejo de error si Chart.js no carga)
// ---------------------------------------------------------------------------

function renderChart(ctx, anterior, data, metric) {
  if (anterior) {
    try { anterior.destroy(); } catch { /* nada */ }
  }
  if (typeof Chart !== "function") {
    // Chart.js (CDN) no llegó a cargarse: dejamos un mensaje en lugar del canvas.
    const host = ctx.parentElement;
    if (host) {
      host.innerHTML = `<p class="chart-fallback">No se ha podido cargar la librería de gráficos. Comprueba tu conexión y recarga.</p>`;
    }
    return null;
  }
  try {
    return new Chart(ctx, {
      type: "line",
      data,
      options: chartOptions(metric, { legend: true }),
    });
  } catch (err) {
    console.error("Chart render falló:", err);
    return null;
  }
}

function chartOptions(metric, opts = {}) {
  const cfg = METRICAS[metric];
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const grid = dark ? "#2a313e" : "#e3e6ec";
  const tick = dark ? "#a8b0c2" : "#5a6275";
  const fmtTick = v => v.toFixed(cfg.decimals).replace(".", ",") + cfg.suffix;
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
            return ctx.dataset.label + ": " + (v == null ? "—" : fmtTick(v));
          },
        },
      },
    },
    scales: {
      x: { grid: { color: grid }, ticks: { color: tick } },
      y: { grid: { color: grid }, ticks: { color: tick, callback: fmtTick } },
    },
  };
}

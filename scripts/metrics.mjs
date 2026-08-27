#!/usr/bin/env node
// Daily growth metrics for the SII agent (ADR-043 companion instrument).
//
// WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT
//
// No model weights are trained in this project. Claude's parameters are fixed, and Llama 3.1 runs
// inference only (ADR-040). So there is no "neural network growth" to report, and reporting one
// would be a lie that a single question from a technically literate reader would expose.
//
// What DOES grow, and is worth reading daily, is four distinct things — kept in four separate
// families here precisely so they are never conflated:
//
//   1. MAPPED SURFACE  — how much of the SII we can read at all. Grows by engineering.
//   2. KNOWLEDGE BASE  — what the system has written down about itself and the domain.
//   3. RIGOUR          — the regression floor that stops the other three from rotting.
//   4. LEARNING LOOP   — the ONLY family that improves between runs without a human editing code
//                        (ADR-043). Everything else is corpus growth, not learning.
//
// THE NULL RULE. A metric with no data reports `null`, never 0. This mirrors `eval/gate.ts`:
// losing the ability to measure something is a regression, not a score of zero. A dashboard that
// prints 0 for "not measured yet" trains its reader to ignore it.
//
// Usage:
//   node scripts/metrics.mjs              print today's snapshot with deltas, append to history
//   node scripts/metrics.mjs --no-write   print only
//   node scripts/metrics.mjs --json       machine-readable snapshot on stdout
//   node scripts/metrics.mjs --history    print the full time series
//
// The auditor store is read when SII_AUDITOR_STORE is set, else ~/.sii/auditor. Absent store =>
// family 4 reports null throughout, which is the honest reading before the loop has ever run.

import { readFile, readdir, stat, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY = join(ROOT, 'docs', 'metrics', 'history.jsonl');
const STORE = process.env.SII_AUDITOR_STORE ?? join(homedir(), '.sii', 'auditor');

const args = new Set(process.argv.slice(2));

// ---------------------------------------------------------------- helpers

async function listFiles(dir, filter = () => true, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

async function countIn(dir, filter) {
  return (await listFiles(dir, filter)).length;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonl(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((v) => v !== null);
  } catch {
    return [];
  }
}

/** Sum of lines across files. */
async function lineCount(files) {
  let n = 0;
  for (const f of files) {
    const text = await readFile(f, 'utf8').catch(() => '');
    n += text.split('\n').length;
  }
  return n;
}

/** Count `it(` / `test(` call sites — the same thing vitest reports as cases. */
async function countTestCases(files) {
  let n = 0;
  for (const f of files) {
    const text = await readFile(f, 'utf8').catch(() => '');
    n += (text.match(/^\s*(it|test)(\.\w+)?\s*\(/gm) ?? []).length;
  }
  return n;
}

/** Count entries in a taxonomy file by counting object-literal keys that look like códigos. */
async function countCodes(path, pattern) {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  return (text.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------- family 1: mapped surface

async function mappedSurface() {
  const isSrc = (p) => extname(p) === '.ts' && !p.endsWith('.test.ts');
  const portal = join(ROOT, 'packages', 'core', 'src', 'portal');
  const tasks = join(ROOT, 'packages', 'core', 'src', 'tasks');

  // Helper/taxonomy modules are NOT facades — counting them as such inflates "surfaces mapped".
  const HELPERS = new Set([
    'f22-codigos.ts',
    'f29-codigos.ts',
    'gwt-schema.ts',
    'gwt.ts',
    'bte-comunas.ts',
  ]);
  const isFacade = (p) => isSrc(p) && !HELPERS.has(p.split(/[\\/]/).pop());

  return {
    fachadasPortal: await countIn(portal, isFacade),
    tareasDominio: await countIn(tasks, isSrc),
    comandosCli: await countIn(join(ROOT, 'packages', 'cli', 'src', 'commands'), isSrc),
    herramientasMcp: await countIn(join(ROOT, 'packages', 'mcp', 'src', 'tools'), isSrc),
    contratosWire: await countIn(join(ROOT, 'docs', 'sii-contract'), (p) => p.endsWith('.md')),
    codigosF29: await countCodes(join(portal, 'f29-codigos.ts'), /^\s*'?\d{1,4}'?\s*:/gm),
    codigosF22: await countCodes(join(portal, 'f22-codigos.ts'), /^\s*'\d{1,5}',?\s*$/gm),
    clasesGwt: await countCodes(join(portal, 'gwt-schema.ts'), /^\s*'[\w.$]+'\s*:/gm),
  };
}

// ---------------------------------------------------------------- family 2: knowledge base

async function knowledgeBase() {
  const graph = await readJson(join(ROOT, 'graphify-out', 'graph.json'));
  let nodos = null;
  let aristas = null;
  let comunidades = null;
  let grafoCommit = null;

  if (graph !== null) {
    nodos = Array.isArray(graph.nodes) ? graph.nodes.length : null;
    aristas = Array.isArray(graph.links) ? graph.links.length : null;
    grafoCommit = typeof graph.built_at_commit === 'string' ? graph.built_at_commit : null;
    if (Array.isArray(graph.nodes)) {
      const c = new Set();
      for (const n of graph.nodes) {
        const id = n?.community ?? n?.cluster ?? n?.group;
        if (id !== undefined && id !== null) c.add(String(id));
      }
      comunidades = c.size > 0 ? c.size : null;
    }
  }

  const adrDir = join(ROOT, 'docs', 'decisions');
  return {
    adrs: await countIn(adrDir, (p) => p.endsWith('.md') && !p.endsWith('_index.md')),
    bitacorasAuditoria: await countIn(join(ROOT, 'docs', 'audits'), (p) => p.endsWith('.md')),
    grafoNodos: nodos,
    grafoAristas: aristas,
    grafoComunidades: comunidades,
    grafoCommit,
  };
}

// ---------------------------------------------------------------- family 3: rigour

async function rigour() {
  const pkgs = join(ROOT, 'packages');
  const srcFiles = await listFiles(pkgs, (p) => extname(p) === '.ts' && !p.endsWith('.test.ts'));
  const testFiles = await listFiles(pkgs, (p) => p.endsWith('.test.ts'));

  const lineasCodigo = await lineCount(srcFiles);
  const lineasPrueba = await lineCount(testFiles);

  return {
    casosDePrueba: await countTestCases(testFiles),
    archivosDePrueba: testFiles.length,
    archivosFuente: srcFiles.length,
    lineasCodigo,
    lineasPrueba,
    razonPruebaCodigo:
      lineasCodigo === 0 ? null : Math.round((lineasPrueba / lineasCodigo) * 100) / 100,
  };
}

// ---------------------------------------------------------------- family 4: learning loop

const STAGES = ['ingest', 'extract', 'mine', 'propose', 'evaluate', 'gate', 'absorb', 'report'];

async function learningLoop() {
  // Stage readiness is read from source, not from a run: it answers "can the loop learn yet?"
  const stageDir = join(ROOT, 'packages', 'auditor', 'src', 'loop', 'stages');
  let etapasImplementadas = null;
  if (existsSync(stageDir)) {
    let done = 0;
    for (const s of STAGES) {
      const text = await readFile(join(stageDir, `${s}.ts`), 'utf8').catch(() => null);
      if (text === null) continue;
      if (!text.includes('NotImplemented')) done += 1;
    }
    etapasImplementadas = done;
  }

  const storePresent = existsSync(STORE);

  const base = {
    etapasImplementadas,
    etapasTotales: STAGES.length,
    almacenPresente: storePresent,
    artefactosAlmacenados: null,
    registrosExtraccion: null,
    enColaDeRevision: null,
    corridas: null,
    ultimaCorrida: null,
    reglasCandidatas: null,
    reglasValidadas: null,
    reglasRetiradas: null,
    compuertaPromovidas: null,
    compuertaRechazadas: null,
    extraccionExactitud: null,
    normativaCobertura: null,
    hallazgosPrecision: null,
    hallazgosRecall: null,
    hallazgosF1: null,
    conjuntoDoradoPresente: existsSync(process.env.SII_AUDITOR_GOLDEN_DIR ?? ' '),
  };

  if (!storePresent) return base;

  // Content-addressed artifacts: <store>/artifacts/<aa>/<bb>/<name>
  const artefactos = await countIn(join(STORE, 'artifacts'), () => true);

  // Extraction records, one JSONL per run.
  const extrDir = join(STORE, 'extractions');
  const extrFiles = await listFiles(extrDir, (p) => p.endsWith('.jsonl'));
  let registros = 0;
  let revision = 0;
  for (const f of extrFiles) {
    const rows = await readJsonl(f);
    registros += rows.length;
    // Mirrors extract/confidence.ts: low confidence is routed to a human.
    revision += rows.filter((r) => typeof r?.confidence === 'number' && r.confidence < 0.8).length;
  }

  // Run manifests.
  const runFiles = await listFiles(join(STORE, 'runs'), (p) => p.endsWith('.json'));
  let ultima = null;
  if (runFiles.length > 0) {
    const stats = await Promise.all(runFiles.map(async (f) => ({ f, m: (await stat(f)).mtimeMs })));
    stats.sort((a, b) => b.m - a.m);
    const manifest = await readJson(stats[0].f);
    if (manifest !== null) {
      ultima = {
        runId: manifest.runId ?? null,
        status: manifest.status ?? null,
        startedAt: manifest.startedAt ?? null,
        etapasOk: Array.isArray(manifest.stages)
          ? manifest.stages.filter((s) => s.status === 'ok').length
          : null,
      };
    }
  }

  // Rules by state.
  const ruleRows = [
    ...(await readJsonl(join(STORE, 'rules.jsonl'))),
    ...((await listFiles(join(STORE, 'rules'), (p) => p.endsWith('.jsonl'))).length > 0
      ? (
          await Promise.all(
            (await listFiles(join(STORE, 'rules'), (p) => p.endsWith('.jsonl'))).map(readJsonl),
          )
        ).flat()
      : []),
  ];
  const byState = (s) => ruleRows.filter((r) => r?.state === s).length;

  // Eval results — the actual learning curve. Ordered by the run's OWN timestamp, never mtime:
  // a file copy or a rebuild reorders mtimes and would silently reshuffle the curve.
  const evalFiles = await listFiles(join(STORE, 'eval'), (p) => p.endsWith('.json'));
  const evals = (await Promise.all(evalFiles.map(readJson)))
    .filter((e) => e !== null)
    .sort((a, b) => String(a.evaluatedAt ?? '').localeCompare(String(b.evaluatedAt ?? '')));
  const latestEval = evals.length > 0 ? evals[evals.length - 1] : null;

  // WHY THE LATEST EVAL IS NOT THE SYSTEM'S ACCURACY.
  //
  // The gate evaluates a BASELINE and one or more CANDIDATES in the same instant, and candidates
  // are frequently deliberate regressions — you exercise a gate by feeding it something worse and
  // checking it says no. So the chronologically last eval is often the WORST strategy anyone
  // tried, not what production runs. Reducing the curve to "latest" would have this dashboard
  // report a collapse on precisely the night the immune system was proven to work.
  //
  // Until gate verdicts are persisted (see `gate.jsonl`, not yet written), the honest reduction is
  // to report both and never conflate them: the best measured result stands in for production,
  // the latest is labelled as what it is.
  // TIE-BREAK ON THE DENOMINATOR, NOT JUST THE RATE. Accuracy alone ranked 1.0-over-48-fields equal
  // to 1.0-over-188, and a strict `>` then kept whichever came FIRST — so this dashboard reported
  // 48 verified fields while the store held a later, strictly stronger 188-field evaluation at the
  // same 1.0. The rate was right and the evidence behind it was understated ~4x, which is the
  // quietly-wrong number this instrument exists to avoid. Same accuracy over more fields is more
  // evidence, so it wins.
  const measured = evals.filter((e) => (e?.extraction?.fieldsCompared ?? 0) > 0);
  const stronger = (e, acc) => {
    const [ea, aa] = [e.extraction.accuracy ?? 0, acc.extraction.accuracy ?? 0];
    if (ea !== aa) return ea > aa;
    return (e.extraction.fieldsCompared ?? 0) > (acc.extraction.fieldsCompared ?? 0);
  };
  const best = measured.reduce((acc, e) => (acc === null || stronger(e, acc) ? e : acc), null);

  // The golden set is the gate's precondition. Detect it from the store, not only from the env
  // var: a run may have been launched from a shell that exported it and this one may not have.
  const goldenDir = process.env.SII_AUDITOR_GOLDEN_DIR ?? join(STORE, 'golden');
  const goldenFiles = await listFiles(goldenDir, (p) => p.endsWith('.json'));

  const gateRows = await readJsonl(join(STORE, 'gate.jsonl'));

  return {
    ...base,
    conjuntoDoradoPresente: goldenFiles.length > 0,
    expedientesDorados: goldenFiles.length === 0 ? null : goldenFiles.length,
    camposVerificados: best?.extraction?.fieldsCompared ?? null,
    evaluaciones: evals.length === 0 ? null : evals.length,
    evaluacionesConDatos: measured.length === 0 ? null : measured.length,
    artefactosAlmacenados: artefactos,
    registrosExtraccion: registros,
    enColaDeRevision: extrFiles.length === 0 ? null : revision,
    corridas: runFiles.length,
    ultimaCorrida: ultima,
    reglasCandidatas: ruleRows.length === 0 ? null : byState('candidate'),
    reglasValidadas: ruleRows.length === 0 ? null : byState('validated'),
    reglasRetiradas: ruleRows.length === 0 ? null : byState('retired'),
    compuertaPromovidas:
      gateRows.length === 0 ? null : gateRows.filter((g) => g?.verdict === 'promote').length,
    compuertaRechazadas:
      gateRows.length === 0 ? null : gateRows.filter((g) => g?.verdict === 'reject').length,
    extraccionExactitud: best?.extraction?.accuracy ?? null,
    extraccionExactitudUltima: latestEval?.extraction?.accuracy ?? null,
    normativaCobertura: best?.normativa?.coverage ?? null,
    hallazgosPrecision: best?.findings?.precision ?? null,
    hallazgosRecall: best?.findings?.recall ?? null,
    hallazgosF1: best?.findings?.f1 ?? null,
  };
}

// ---------------------------------------------------------------- snapshot + rendering

async function snapshot() {
  const [superficie, conocimiento, rigor, aprendizaje] = await Promise.all([
    mappedSurface(),
    knowledgeBase(),
    rigour(),
    learningLoop(),
  ]);
  return {
    fecha: new Date().toISOString().slice(0, 10),
    tomadoEn: new Date().toISOString(),
    superficie,
    conocimiento,
    rigor,
    aprendizaje,
  };
}

function flat(snap) {
  const out = {};
  for (const family of ['superficie', 'conocimiento', 'rigor', 'aprendizaje']) {
    for (const [k, v] of Object.entries(snap[family] ?? {})) {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') out[`${family}.${k}`] = v;
    }
  }
  return out;
}

const LABELS = {
  'superficie.fachadasPortal': 'Fachadas del portal SII',
  'superficie.tareasDominio': 'Tareas de dominio',
  'superficie.comandosCli': 'Módulos de comando CLI',
  'superficie.herramientasMcp': 'Módulos de herramientas MCP',
  'superficie.contratosWire': 'Contratos de protocolo documentados',
  'superficie.codigosF29': 'Códigos F29 en la taxonomía',
  'superficie.codigosF22': 'Códigos F22 en la taxonomía',
  'superficie.clasesGwt': 'Clases del esquema GWT',
  'conocimiento.adrs': 'Decisiones de arquitectura (ADR)',
  'conocimiento.bitacorasAuditoria': 'Bitácoras de validación en vivo',
  'conocimiento.grafoNodos': 'Nodos del grafo de conocimiento',
  'conocimiento.grafoAristas': 'Aristas del grafo',
  'conocimiento.grafoComunidades': 'Comunidades detectadas',
  'rigor.casosDePrueba': 'Casos de prueba',
  'rigor.archivosDePrueba': 'Archivos de prueba',
  'rigor.archivosFuente': 'Archivos fuente',
  'rigor.lineasCodigo': 'Líneas de código',
  'rigor.lineasPrueba': 'Líneas de prueba',
  'rigor.razonPruebaCodigo': 'Razón prueba/código',
  'aprendizaje.etapasImplementadas': 'Etapas del bucle implementadas',
  'aprendizaje.expedientesDorados': 'Expedientes en el conjunto dorado',
  'aprendizaje.camposVerificados': 'Campos con verdad verificada',
  'aprendizaje.evaluaciones': 'Evaluaciones registradas',
  'aprendizaje.evaluacionesConDatos': 'Evaluaciones con datos reales',
  'aprendizaje.artefactosAlmacenados': 'Artefactos con procedencia',
  'aprendizaje.registrosExtraccion': 'Registros de extracción',
  'aprendizaje.enColaDeRevision': 'En cola de revisión humana',
  'aprendizaje.corridas': 'Corridas nocturnas',
  'aprendizaje.reglasCandidatas': 'Reglas candidatas',
  'aprendizaje.reglasValidadas': 'Reglas validadas',
  'aprendizaje.reglasRetiradas': 'Reglas retiradas',
  'aprendizaje.compuertaPromovidas': 'Cambios promovidos por la compuerta',
  'aprendizaje.compuertaRechazadas': 'Cambios rechazados por la compuerta',
  'aprendizaje.extraccionExactitud': '▸ Exactitud de extracción (mejor)',
  'aprendizaje.extraccionExactitudUltima': '▸ Exactitud de la última corrida',
  'aprendizaje.normativaCobertura': '▸ Cobertura de normativa',
  'aprendizaje.hallazgosPrecision': '▸ Precisión de hallazgos',
  'aprendizaje.hallazgosRecall': '▸ Recall de hallazgos',
  'aprendizaje.hallazgosF1': '▸ F1 de hallazgos',
};

const FAMILIES = [
  ['superficie', '1 · SUPERFICIE MAPEADA DEL SII', 'crece por ingeniería'],
  ['conocimiento', '2 · BASE DE CONOCIMIENTO', 'crece por observación y registro'],
  ['rigor', '3 · RIGOR Y REGRESIÓN', 'el piso que impide que lo anterior se pudra'],
  ['aprendizaje', '4 · BUCLE DE APRENDIZAJE (ADR-043)', 'lo ÚNICO que mejora sin editar código'],
];

function fmt(v) {
  if (v === null || v === undefined) return 'sin datos';
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (Number.isInteger(v)) return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return String(v);
}

function delta(now, before) {
  if (now === null || before === null || before === undefined) return '';
  if (typeof now !== 'number' || typeof before !== 'number') return '';
  const d = Math.round((now - before) * 10000) / 10000;
  if (d === 0) return '·';
  return d > 0 ? `+${fmt(d)}` : `${fmt(d)}`;
}

function render(snap, prev, first) {
  const now = flat(snap);
  const before = prev === null ? {} : flat(prev);
  const origin = first === null ? {} : flat(first);

  const lines = [];
  lines.push('');
  lines.push(`  CRECIMIENTO DEL AGENTE TRIBUTARIO — ${snap.fecha}`);
  lines.push(
    prev === null
      ? '  Primera instantánea: no hay comparación previa.'
      : `  Comparado con ${prev.fecha}${first !== null && first.fecha !== prev.fecha ? ` · origen ${first.fecha}` : ''}`,
  );
  lines.push('');

  for (const [family, title, note] of FAMILIES) {
    lines.push(`  ${title}`);
    lines.push(`  ${'─'.repeat(76)}`);
    lines.push(`  ${note}`);
    lines.push('');
    for (const key of Object.keys(now)) {
      if (!key.startsWith(`${family}.`)) continue;
      const label = LABELS[key];
      if (label === undefined) continue;
      const value = fmt(now[key]).padStart(11);
      const d = delta(now[key], before[key]).padStart(9);
      const total = delta(now[key], origin[key]).padStart(9);
      lines.push(`  ${label.padEnd(38)}${value}${d}${total}`);
    }
    lines.push('');
  }

  lines.push(
    `  ${' '.repeat(38)}${'valor'.padStart(11)}${'día'.padStart(9)}${'total'.padStart(9)}`,
  );
  lines.push('');

  // The one interpretive line the dashboard is allowed to make.
  const a = snap.aprendizaje;
  lines.push(`  ESTADO DEL APRENDIZAJE`);
  lines.push(`  ${'─'.repeat(76)}`);
  if (a.etapasImplementadas === null) {
    lines.push('  El paquete auditor no está presente. Sin bucle, no hay aprendizaje que medir.');
  } else if (!a.conjuntoDoradoPresente) {
    lines.push(
      '  BLOQUEADO — no hay conjunto dorado (SII_AUDITOR_GOLDEN_DIR sin definir o vacío).',
    );
    lines.push('  La compuerta rechaza TODO por diseño en esta condición (eval/gate.ts, regla 1).');
    lines.push(
      '  Ninguna métrica objetivo puede calcularse hasta que exista. Es el cuello de botella.',
    );
  } else if (a.corridas === null || a.corridas === 0) {
    lines.push('  Conjunto dorado presente, pero el bucle nunca ha corrido. `make nightly-dry`.');
  } else if (a.extraccionExactitud === null) {
    lines.push(
      '  El bucle corrió, pero no hay resultado de evaluación. Revisar la etapa evaluate.',
    );
  } else {
    const pct = (v) => (v === null ? 'sin datos' : `${Math.round(v * 1000) / 10}%`);
    lines.push(
      `  MIDIENDO. Exactitud de extracción ${pct(a.extraccionExactitud)} sobre ${fmt(a.camposVerificados)} campos`,
    );
    lines.push(
      `  con verdad verificada, en ${fmt(a.expedientesDorados)} expediente(s) del conjunto dorado.`,
    );
    if (
      a.extraccionExactitudUltima !== null &&
      a.extraccionExactitudUltima < a.extraccionExactitud
    ) {
      lines.push(
        `  La última evaluación dio ${pct(a.extraccionExactitudUltima)}: es una CANDIDATA peor, no una regresión`,
      );
      lines.push(
        '  en producción. La compuerta existe justamente para rechazarla. No leerla como caída.',
      );
    }
    lines.push(
      '  Prioridad 1: la compuerta no promueve nada que baje esta cifra, ni con tolerancia.',
    );
    if (a.normativaCobertura === null) {
      lines.push('  Normativa y hallazgos aún sin denominador: el conjunto dorado no los declara.');
    }
  }
  lines.push(`  Etapas listas: ${a.etapasImplementadas ?? '?'} / ${a.etapasTotales}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------- main

const snap = await snapshot();

if (args.has('--json')) {
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

const history = await readJsonl(HISTORY);

if (args.has('--history')) {
  for (const h of history) {
    const f = flat(h);
    console.log(
      `${h.fecha}  fachadas=${f['superficie.fachadasPortal']}  contratos=${f['superficie.contratosWire']}  pruebas=${f['rigor.casosDePrueba']}  adr=${f['conocimiento.adrs']}  exactitud=${fmt(f['aprendizaje.extraccionExactitud'])}`,
    );
  }
  process.exit(0);
}

const prev = history.length > 0 ? history[history.length - 1] : null;
const first = history.length > 0 ? history[0] : null;

console.log(render(snap, prev, first));

if (!args.has('--no-write')) {
  await mkdir(dirname(HISTORY), { recursive: true });
  await appendFile(HISTORY, `${JSON.stringify(snap)}\n`, 'utf8');
  console.log(
    `  Instantánea añadida a docs/metrics/history.jsonl (${history.length + 1} en total)`,
  );
  console.log('');
}

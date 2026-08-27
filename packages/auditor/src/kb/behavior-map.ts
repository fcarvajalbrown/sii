// The webapp behavior map (ADR-043) — structural knowledge of the SII site.
//
// This is the collection that makes the crawlers self-healing: page shapes, form fields and their
// semantics, endpoint behaviours, and the observed history of changes to all three. When stage 1
// detects that a page no longer matches its recorded shape, the diff against this map is what says
// WHICH selector broke and what it used to be.
//
// IT IS NOT STARTING FROM ZERO. The project already holds this knowledge, in prose:
//
//   * `docs/sii-contract/*.md` (17 files) — request shape, response shape, observation date, per
//     surface. Exactly this schema's fields, written for a human.
//   * `docs/ESTADO-CONSOLIDADO.md` — a URL inventory where every entry is marked OBSERVADA or
//     HIPÓTESIS, and write surfaces are flagged ⛔. That distinction is modelled below as
//     `Observation.status` and `EndpointFact.effect`, because it is load-bearing: ADR-032 lost a
//     session to a link that looked like a read and configured an email address, and ADR-040 built
//     a denylist in CODE precisely because an LLM's guess about read-vs-write is not a safety
//     mechanism.
//   * `tools/crawler` (ADR-040) — already captures page/link/resource structure. Its output is the
//     natural INPUT to this map; its findings stay CANDIDATES until a human promotes them, and
//     that posture carries over unchanged.
//
// CONFIDENTIALITY: this collection is OUTSIDE the boundary (`confidential.ts`) — it describes
// SII's website, which is not client data. Captured page bodies are NOT stored here (they are
// artifacts, and they contain taxpayer data); only structure is.

import { NotImplemented } from '../errors.js';

/** Whether a fact was seen live or is still a guess. Ported from `ESTADO-CONSOLIDADO.md`'s rule. */
export type ObservationStatus = 'observada' | 'hipotesis';

/** What calling an endpoint DOES. `escritura` is never exercised by anything in this package. */
export type EndpointEffect = 'lectura' | 'escritura' | 'desconocido';

/** The nine wire shapes this project has met (ADR-014 through ADR-042). Open — a tenth will come. */
export type WireShape =
  | 'sdi-json'
  | 'rest-json-rut-in-path'
  | 'cviewcarta-cgi'
  | 'legacy-cgi-inline-js'
  | 'form-post-html'
  | 'gwt-rpc'
  | 'rendered-dom'
  | 'public-cgi'
  | 'binary';

export interface Observation {
  readonly status: ObservationStatus;
  /** `YYYY-MM-DD` the fact was seen. ADR-004's citation date, as data. */
  readonly observedAt: string;
  /** Where the claim comes from — an ADR id, a contract doc path, or a crawler run id. */
  readonly source: string;
}

export interface FieldFact {
  readonly name: string;
  /** What it means in domain terms, e.g. `período tributario, formato YYYYMM as a JSON STRING`. */
  readonly semantics: string;
  readonly required: boolean;
  /**
   * Encoding traps that have actually bitten this project. Free text, because each is specific:
   * DJ's `periodo` must be a JSON string in one endpoint and a bare number in another (ADR-030/031)
   * — an inconsistency in SII's own API that no type can express.
   */
  readonly trap: string | null;
  readonly observation: Observation;
}

export interface EndpointFact {
  readonly id: string;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly wireShape: WireShape;
  readonly effect: EndpointEffect;
  /** Request fields. */
  readonly fields: readonly FieldFact[];
  /**
   * Preconditions the transport silently depends on. DJ needs a `goto` bootstrap plus a paced wait
   * or it returns a bare 401; `rfiInternet` needs an `X-GWT-Permutation` header or a byte-identical
   * HTTP 500 (ADR-030, ADR-034). Both cost real production time to find.
   */
  readonly preconditions: readonly string[];
  /** Response envelope key or shape marker, e.g. `respEstado`, `listCarpetaTributaria`, `//OK[…]`. */
  readonly envelope: string | null;
  readonly observation: Observation;
}

export interface PageFact {
  readonly id: string;
  readonly url: string;
  readonly title: string | null;
  /** Selectors/anchors a facade depends on. Their absence is what stage 1 reports as broken. */
  readonly selectors: readonly SelectorFact[];
  /** Endpoints this page is known to call. */
  readonly endpoints: readonly string[];
  /**
   * Write actions VISIBLE on this page. Recorded so no reader ever wanders into one: the giros
   * page exposes "Pagar", carpeta exposes "Anular", `sistgiInternet` can declare término de giro.
   * `giros.ts` pins its read-only-ness with a test asserting the script never mentions "Pagar"
   * (ADR-034) — this field is the machine-readable form of that vigilance.
   */
  readonly writeActions: readonly string[];
  readonly observation: Observation;
}

export interface SelectorFact {
  readonly name: string;
  /**
   * How the element is found. STRONGLY prefer a header NAME over a positional index: ADR-034 chose
   * header mapping precisely because a positional map fails SILENTLY when a column is inserted,
   * while a named one fails loudly ("scraper roto"). Recording the strategy lets stage 1 flag a
   * positional selector as fragile before it lies.
   */
  readonly strategy: 'header-name' | 'css' | 'js-global' | 'position';
  readonly value: string;
  readonly observation: Observation;
}

/** One detected change between two observations of the same fact. The self-healing input. */
export interface StructuralChange {
  readonly factId: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly what: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly detectedAt: string;
  /** True when a facade depends on the changed fact — i.e. something is now broken, not just new. */
  readonly breaksFacade: boolean;
}

export interface BehaviorMap {
  upsertPage(page: PageFact): Promise<void>;
  upsertEndpoint(endpoint: EndpointFact): Promise<void>;
  page(id: string): Promise<PageFact | null>;
  endpoint(id: string): Promise<EndpointFact | null>;
  /** Every fact, `id` ascending — the deterministic basis for a full structural diff. */
  pages(): Promise<readonly PageFact[]>;
  endpoints(): Promise<readonly EndpointFact[]>;
  /** Append detected changes. Append-only: the history IS the value of this collection. */
  recordChanges(changes: readonly StructuralChange[]): Promise<void>;
  changesSince(instant: string): Promise<readonly StructuralChange[]>;
}

/**
 * Import the existing prose knowledge into the map.
 *
 * DEFERRED. Parsing 17 hand-written markdown contracts plus `ESTADO-CONSOLIDADO.md` into typed
 * facts is itself an extraction problem with its own accuracy question — and getting an
 * `effect: 'lectura'` wrong on a write endpoint is the one error class this project treats as
 * unacceptable (ADR-040). The right first move is a human-curated seed of the surfaces already in
 * production, not a parser over prose.
 */
export function importFromContractDocs(_docsDir: string): Promise<readonly EndpointFact[]> {
  throw new NotImplemented(
    'importFromContractDocs',
    'parsing 17 prose contracts into typed facts is its own extraction problem, and a misparsed ' +
      '`effect` would mark a WRITE endpoint readable — seed the map by hand from the shipped ' +
      'surfaces first',
  );
}

export function createFileBehaviorMap(root: string): BehaviorMap {
  const why = `the file-backed behavior map is scaffolded but not written yet (root: ${root})`;
  return {
    upsertPage: (_page: PageFact): Promise<void> => {
      throw new NotImplemented('BehaviorMap.upsertPage', why);
    },
    upsertEndpoint: (_endpoint: EndpointFact): Promise<void> => {
      throw new NotImplemented('BehaviorMap.upsertEndpoint', why);
    },
    page: (_id: string): Promise<PageFact | null> => {
      throw new NotImplemented('BehaviorMap.page', why);
    },
    endpoint: (_id: string): Promise<EndpointFact | null> => {
      throw new NotImplemented('BehaviorMap.endpoint', why);
    },
    pages: (): Promise<readonly PageFact[]> => {
      throw new NotImplemented('BehaviorMap.pages', why);
    },
    endpoints: (): Promise<readonly EndpointFact[]> => {
      throw new NotImplemented('BehaviorMap.endpoints', why);
    },
    recordChanges: (_changes: readonly StructuralChange[]): Promise<void> => {
      throw new NotImplemented('BehaviorMap.recordChanges', why);
    },
    changesSince: (_instant: string): Promise<readonly StructuralChange[]> => {
      throw new NotImplemented('BehaviorMap.changesSince', why);
    },
  };
}

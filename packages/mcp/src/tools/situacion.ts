// `situacion_tributaria` MCP tool (ADR-035). Llamada fina a un task de
// @dostertags/sii-core (ADR-003), solo lectura. SESSION-KEYED, sin argumentos.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { situacionTributaria, type Runtime } from '@dostertags/sii-core';
import { toolText } from '../tool-helpers.js';

export function registerSituacionTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'situacion_tributaria',
    {
      title: 'Situación tributaria del titular',
      description:
        'Situación tributaria del titular en una sola lectura: régimen vigente (ej. 14A ' +
        'semi integrado / 14D Pro-Pyme), FECHA DE INICIO DE ACTIVIDADES (útil para no reportar ' +
        'como incumplimiento un período anterior a la existencia del contribuyente), ' +
        'actividades económicas, documentos timbrados, y el cumplimiento de las obligaciones ' +
        'de la Ley COT con cada requisito marcado como cumplido o no. Expone la identidad ' +
        'propia del titular (razón social, tipo de contribuyente); NO expone socios, ' +
        'representantes ni direcciones — de esos solo informa cuántos hay, porque son datos de ' +
        'terceros. SESSION-KEYED: lee SIEMPRE el titular de la sesión (no acepta otro RUT).',
      annotations: { readOnlyHint: true },
    },
    () => toolText(async () => JSON.stringify(await situacionTributaria(runtime), null, 2)),
  );
}

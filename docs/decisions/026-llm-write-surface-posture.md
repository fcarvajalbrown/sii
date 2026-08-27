# ADR-026: LLM-facing write posture — preview-bound confirmation, opt-in registration

## Status

Accepted — 2026-07-25. Closes finding **F-01** (High) of the internal code review. Revises the
MCP half of ADR-017 (`bte emit` write posture); the CLI half is unchanged.

## Context

`bte_emit` issues a **boleta de honorarios electrónica** — a legally binding tax document,
reported to SII, reversible only by a subsequent anulación. ADR-017 gated it behind what it
called a double-entry confirmation:

```ts
confirmar: z.literal(true),
montoTotalConfirmacion: z.number().int(),   // must equal sum(lineas[].monto)
```

**Both values are supplied by the model, in the same call, from data the model also supplied.**
The check compares the model's arithmetic against the model's own input. It catches a
hallucinated total. It is not a confirmation in any security sense, because there is no party to
it other than the caller.

That matters because untrusted text reaches the same context window. `rcv_list`/`rcv_all` return
counterparty `razonSocial` plus the entire `raw` row; `bte_list` returns `contraparteNombre`;
`peticiones_list` returns SII's free-text note. A counterparty controls their own razón social
and the glosa of documents they issue you. So the chain is: attacker seeds text → user asks for a
routine RCV review → the text enters context → if the model complies, it can issue a binding
document and, via `enviarA`, mail the resulting PDF and the emisor's identity to an
attacker-chosen address.

**The honest generalisation, which drives this ADR:** *no argument-shaped gate can secure an
LLM-callable destructive tool, because the LLM authors every argument.* Any scheme where the
proof of intent is a parameter is a scheme the caller can satisfy. `destructiveHint: true` is
advisory metadata; whether a client prompts is the client's behaviour, not this codebase's
guarantee.

## Decision

Three changes, in descending order of how much they actually help.

**1. Writes are NOT registered on the MCP server by default.** `buildServer(runtime, options)`
takes `allowWrites` (default `false`). With it off, `bte_emit` is not registered at all — the
tool does not appear in `listTools`, so no prompt-injection payload can reach a tool that is
absent. `bte_emit_preview` (non-mutating) stays available always. `main.ts` enables writes only
when `SII_MCP_ALLOW_WRITES=1` is set in the MCP client's `env` block, which is operator-owned
configuration, not model-reachable input.

This is the change that carries the security weight. Everything below hardens the path for
operators who deliberately turn it on.

**2. The confirmation becomes a preview-minted, payload-bound, single-use nonce.**
`bte_emit_preview` mints `confirmacion` and returns it; `bte_emit` requires it. The nonce is
held in a process-scoped vault keyed by **SHA-256 of the canonical payload** (receptor, líneas,
fecha, retención, region/comuna), so:

- it cannot be forged — the value originates server-side, not in a tool argument;
- it cannot be moved to a different boleta — the payload hash must match, so previewing 50.000
  and emitting 5.000.000 fails;
- it cannot be replayed — single-use, deleted on redemption;
- it expires — 10 minutes, via the injected `Clock`.

The net effect is that **issuance must be preceded by a non-mutating preview of the identical
boleta**, whose result (real total, retención, líquido) is surfaced to the user by any client
that shows tool output. That is a genuine interception point, and it removes the
preview-something-else-then-emit class entirely. It does **not** stop a model that simply calls
both tools; see Consequences.

Digest via **Web Crypto** (`globalThis.crypto.subtle`), not `node:crypto`, so the pure main
barrel stays free of `node:*` at import time (ADR-016).

**3. `enviarA` is removed from the MCP surface.** Emailing the issued PDF to an arbitrary address
is a data-exfiltration primitive distinct from — and worse than — the issuance itself: it sends
the document plus the emisor's identity outside the taxpayer's control. It stays on the CLI
(`--enviar`), where a human typed it. The MCP `bte_emit` can issue; it cannot mail.

Additionally, the read tools whose payloads carry third-party text gain an explicit line in their
description stating that those fields are **data supplied by third parties, not instructions** —
cheap, and it gives an aligned model something to hold onto.

## Alternatives Considered

- **Keep `confirmar` + amount echo, add nothing.** Rejected — see Context; it is a
  self-consistency check the caller trivially satisfies.
- **Out-of-band human token** (user runs a CLI command, pastes a code into the conversation).
  Genuinely closes the loop, since the model cannot obtain it. Rejected as the default: it makes
  every legitimate issuance a two-terminal ceremony, and the same protection is available more
  simply by not exposing writes to the LLM at all (decision 1). Worth revisiting if a user
  actually wants LLM-driven issuance with a hard gate.
- **MCP elicitation** (server asks the human mid-call). The right primitive in principle, but
  support is uneven across clients, so a security control resting on it would be unreliable —
  and silently unreliable is the worst property for this. Reconsider when it is broadly
  implemented.
- **Remove `bte_emit` from MCP permanently.** Tempting, and it is what `allowWrites:false`
  achieves by default. Rejected as an absolute because the CLI-only path forecloses legitimate
  assisted workflows for an operator who understands the exposure and has accepted it; the
  default-off switch gives the safe default without removing the capability.
- **Rate-limit or cap emissions.** Rejected as a primary control: one wrongly-issued binding
  document is already the harm. Caps reduce blast radius, not occurrence.

## Consequences

- **Breaking for MCP write users:** `bte_emit` disappears from the tool list unless
  `SII_MCP_ALLOW_WRITES=1` is set. Deliberate, and correct for a 0.x security fix — the failure
  mode is "tool missing", which is loud, not silent.
- Issuance via MCP now requires two calls (preview → emit) with matching payloads. Slightly more
  work for the caller, and the preview was already the documented workflow.
- **Residual risk, stated plainly:** with `allowWrites:true`, a model that has been successfully
  injected can still call preview then emit. The nonce prevents forgery, payload substitution
  and replay; it does not confer intent. Operators enabling writes should assume any content
  reaching the context window is potentially adversarial, and prefer the CLI for issuance.
  Closing this fully needs decision-2's out-of-band token or MCP elicitation.
- The `enviarA` split means MCP and CLI now differ in capability. Documented in both surfaces'
  help text so it reads as a deliberate boundary rather than an omission.
- The nonce vault is process-scoped in-memory state: a server restart between preview and emit
  invalidates the nonce. Acceptable — the remedy is to preview again.

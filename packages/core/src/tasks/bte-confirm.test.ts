import { describe, it, expect, beforeEach } from 'vitest';
import { FixedClock } from '../adapters/fake/index.js';
import {
  mintEmitConfirmation,
  redeemEmitConfirmation,
  resetEmitConfirmations,
} from './bte-confirm.js';

// A canonical emit payload. Two objects with the same tax content must hash the same; any change
// to a load-bearing field must not (ADR-026).
const payload = (over: Record<string, unknown> = {}) => ({
  receptor: '77777777-7',
  lineas: [{ glosa: 'Asesoría agronómica', monto: 500_000 }],
  fecha: { dia: 25, mes: 7, anio: 2026 },
  retiene: 'RECEPTOR',
  region: 13,
  comuna: 101,
  ...over,
});

describe('emit confirmation vault (ADR-026 — F-01)', () => {
  beforeEach(() => resetEmitConfirmations());

  it('mints a nonce that redeems exactly once for the SAME payload', async () => {
    const clock = new FixedClock(new Date('2026-07-25T12:00:00Z'));
    const nonce = await mintEmitConfirmation(payload(), clock);

    expect(nonce).toMatch(/[0-9a-f-]{16,}/); // opaque, server-generated
    await expect(redeemEmitConfirmation(nonce, payload(), clock)).resolves.toBe(true);
    // Single use: the second redemption of the same nonce fails.
    await expect(redeemEmitConfirmation(nonce, payload(), clock)).resolves.toBe(false);
  });

  it('REJECTS a nonce redeemed against a different payload — the payload-swap attack', async () => {
    const clock = new FixedClock(new Date('2026-07-25T12:00:00Z'));
    // Preview a small boleta…
    const nonce = await mintEmitConfirmation(payload(), clock);

    // …then try to issue a much larger one with the same confirmation.
    const swapped = payload({ lineas: [{ glosa: 'Asesoría agronómica', monto: 5_000_000 }] });
    await expect(redeemEmitConfirmation(nonce, swapped, clock)).resolves.toBe(false);
  });

  it('binds every load-bearing field, not just the amount', async () => {
    const clock = new FixedClock(new Date('2026-07-25T12:00:00Z'));
    for (const over of [
      { receptor: '20000042-0' }, // different counterparty
      { retiene: 'EMISOR' }, // who withholds changes the tax effect
      { fecha: { dia: 1, mes: 7, anio: 2026 } },
      { region: 5, comuna: 501 },
      { lineas: [{ glosa: 'Otra prestación', monto: 500_000 }] }, // same amount, different glosa
    ]) {
      resetEmitConfirmations();
      const nonce = await mintEmitConfirmation(payload(), clock);
      await expect(redeemEmitConfirmation(nonce, payload(over), clock)).resolves.toBe(false);
    }
  });

  it('is insensitive to line ORDER and key order — same tax content, same hash', async () => {
    const clock = new FixedClock(new Date('2026-07-25T12:00:00Z'));
    const two = [
      { glosa: 'A', monto: 1000 },
      { glosa: 'B', monto: 2000 },
    ];
    const nonce = await mintEmitConfirmation(payload({ lineas: two }), clock);
    // Reversed line order is the same boleta; a naive JSON.stringify hash would reject it.
    await expect(
      redeemEmitConfirmation(nonce, payload({ lineas: [...two].reverse() }), clock),
    ).resolves.toBe(true);
  });

  it('expires after the TTL, via the injected clock', async () => {
    const clock = new FixedClock(new Date('2026-07-25T12:00:00Z'));
    const nonce = await mintEmitConfirmation(payload(), clock);

    clock.set(new Date('2026-07-25T12:09:00Z')); // 9 min — still valid
    const stillOk = await redeemEmitConfirmation(nonce, payload(), clock);
    expect(stillOk).toBe(true);

    resetEmitConfirmations();
    const n2 = await mintEmitConfirmation(payload(), clock);
    clock.set(new Date('2026-07-25T12:20:00Z')); // 11 min later — past the 10 min TTL
    await expect(redeemEmitConfirmation(n2, payload(), clock)).resolves.toBe(false);
  });

  it('rejects an unknown or empty nonce — nothing is accepted by default', async () => {
    const clock = new FixedClock(new Date('2026-07-25T12:00:00Z'));
    await expect(redeemEmitConfirmation('not-a-nonce', payload(), clock)).resolves.toBe(false);
    await expect(redeemEmitConfirmation('', payload(), clock)).resolves.toBe(false);
  });
});

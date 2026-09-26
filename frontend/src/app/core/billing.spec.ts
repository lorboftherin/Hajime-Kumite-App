import { describe, expect, it } from 'vitest';
import { alertText, invoiceNumber, penFromCents } from './billing';
import { BillingAlert } from './models';

const alert = (over: Partial<BillingAlert>): BillingAlert => ({
  subscription_id: 1,
  organization_id: 3,
  organization_name: 'Liga Sur',
  plan_name: 'Dojo',
  status: 'active',
  days_left: 5,
  in_grace: false,
  recurring: false,
  access_until: null,
  ...over,
});

describe('billing', () => {
  it('muestra los céntimos como soles', () => {
    expect(penFromCents(6900)).toBe('S/ 69');
    expect(penFromCents(3450)).toMatch(/^S\/ 34[.,]50$/);
    expect(penFromCents(null)).toBe('S/ 0');
  });

  it('arma el aviso de vencimiento y el de gracia', () => {
    expect(alertText(alert({}))).toBe('Dojo de Liga Sur vence en 5 días.');
    expect(alertText(alert({ days_left: 1, organization_name: null }))).toBe(
      'Tu plan Dojo vence en 1 día.',
    );
    expect(alertText(alert({ days_left: 0 }))).toBe('Dojo de Liga Sur vence hoy.');
    expect(alertText(alert({ in_grace: true, days_left: 7 }))).toContain('7 días de gracia');
  });

  it('numera el comprobante con 8 dígitos', () => {
    expect(invoiceNumber('BBB1', 12)).toBe('BBB1-00000012');
  });
});

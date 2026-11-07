import { describe, expect, it } from 'vitest';
import { cleanRules, editableKata, kataPayload } from './rules-form';

describe('rules-form', () => {
  it('quita los campos vacíos para que hereden', () => {
    expect(
      cleanRules({ tie_rule: 'hantei', lead_victory: 0, time_mode: undefined, x: null, y: '' }),
    ).toEqual({
      tie_rule: 'hantei',
      lead_victory: 0,
    });
    expect(cleanRules({ a: undefined })).toBeNull();
  });

  it('convierte el texto de rondas de kata en lista y vuelve', () => {
    expect(kataPayload({ _rounds_text: '8, 4', preset: 'wkf' })).toEqual({
      rounds: [8, 4],
      preset: 'wkf',
    });
    expect(kataPayload({ _rounds_text: '' })).toBeNull();
    const edit = editableKata({ rounds: [8, 4], judges: 5 });
    expect(edit).toEqual({ _rounds_text: '8, 4', judges: 5 });
  });
});

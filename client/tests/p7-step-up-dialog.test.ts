// client/tests/p7-step-up-dialog.test.ts
//
// P7 B2 — the product dialog's input modes used by the step-up prompt: a
// password is masked and offered from the password manager, an authenticator /
// backup code is offered as a one-time code, and the default stays a plain,
// non-autocompleted text field.

import { afterEach, describe, expect, it } from 'vitest';
import { closeProductDialog, promptProductText } from '../js/core/product-dialog.ts';

const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('.bridge-product-dialog-input')!;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

afterEach(() => {
  closeProductDialog();
  document.body.innerHTML = '';
});

describe('product dialog input modes (P7 B2 step-up)', () => {
  it('password: masked, current-password autocomplete, value returned on confirm', async () => {
    const pending = promptProductText({ message: 'Confirm', inputType: 'password' });
    await flush();
    expect(input().type).toBe('password');
    expect(input().autocomplete).toBe('current-password');
    input().value = 's3cret';
    document.querySelector<HTMLButtonElement>('[data-product-dialog-action="confirm"]')!.click();
    await expect(pending).resolves.toBe('s3cret');
  });

  it('one-time-code: text field offering the one-time code, no auto-capitalisation', async () => {
    const pending = promptProductText({ message: 'Confirm', inputType: 'one-time-code' });
    await flush();
    expect(input().type).toBe('text');
    expect(input().autocomplete).toBe('one-time-code');
    expect(input().getAttribute('autocapitalize')).toBe('off');
    closeProductDialog();
    await expect(pending).resolves.toBeNull();
  });

  it('default: plain text without autocomplete', async () => {
    const pending = promptProductText({ message: 'Rename' });
    await flush();
    expect(input().type).toBe('text');
    expect(input().autocomplete).toBe('off');
    expect(input().hasAttribute('autocapitalize')).toBe(false);
    closeProductDialog();
    await pending;
  });
});

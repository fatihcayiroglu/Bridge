// client/tests/p7-step-up-dialog.test.ts
//
// P7 B2 — the product dialog as the step-up prompt: input modes (a password is
// masked and offered from the password manager, an authenticator / backup code
// is offered as a one-time code, the default stays plain text) and accessibility
// (visible associated label, announced error, aria-invalid, keyboard-only use,
// focus trap, safe default focus).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeProductDialog, promptProductText } from '../js/core/product-dialog.ts';
import { clearStepUpGrants, obtainStepUp } from '../js/core/step-up.ts';
import { t } from '../js/core/i18n/index.ts';

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

// ── Accessibility of the step-up prompt (real dialog + real step-up owner) ────

const refusal = {
  error: 'STEP_UP_REQUIRED' as const, action: 'account.delete', scope: 'destructive-admin' as const,
  reasons: ['step_up_missing'], level: 1, methods: ['password', 'sign_in'],
};
const proofResponse = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

function key(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

async function waitForInput(): Promise<HTMLInputElement> {
  await vi.waitFor(() => expect(document.querySelector('.bridge-product-dialog-input')).not.toBeNull());
  await flush();
  return input();
}

describe('step-up prompt accessibility', () => {
  afterEach(() => { clearStepUpGrants(); });

  it('the field has a visible, associated label; focus starts in it; the dialog is labelled and described', async () => {
    const pending = obtainStepUp(refusal, null, { send: vi.fn(), signInAgain: vi.fn() });
    const field = await waitForInput();
    const label = document.querySelector<HTMLLabelElement>('.bridge-product-dialog-label')!;
    expect(label.textContent).toBe(t('stepup_password_label'));
    expect(label.htmlFor).toBe(field.id);
    expect(field.labels?.[0]).toBe(label);
    expect(document.activeElement).toBe(field);
    const card = document.querySelector('.bridge-product-dialog')!;
    expect(document.getElementById(card.getAttribute('aria-labelledby')!)!.textContent).toBe(t('stepup_title'));
    expect(document.getElementById(card.getAttribute('aria-describedby')!)!.textContent).toBe(t('stepup_why_account_delete'));
    expect(field.hasAttribute('aria-invalid')).toBe(false);
    key(field, { key: 'Escape' });
    await expect(pending).resolves.toBeNull();
  });

  it('is fully keyboard operable: type, Enter submits; a wrong proof is announced and the field marked invalid', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(proofResponse({ error: 'STEP_UP_PROOF_INVALID', locked: false }, 400))
      .mockResolvedValueOnce(proofResponse({ ok: true, stepUp: { token: 'grant', expiresAt: Date.now() + 600_000 } }));
    const pending = obtainStepUp(refusal, null, { send, signInAgain: vi.fn() });

    let field = await waitForInput();
    field.value = 'wrong';
    key(field, { key: 'Enter' });
    await vi.waitFor(() => expect(document.querySelector('.bridge-product-dialog-error')).not.toBeNull());
    await flush();
    field = input();
    const problem = document.querySelector<HTMLElement>('.bridge-product-dialog-error')!;
    expect(problem.getAttribute('role')).toBe('alert');
    expect(problem.textContent).toBe(t('stepup_wrong'));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(problem.id);
    expect(document.activeElement).toBe(field);

    field.value = 'right';
    key(field, { key: 'Enter' });
    await expect(pending).resolves.toBe('grant');
    expect(send).toHaveBeenNthCalledWith(2, '/api/step-up/password', { password: 'right', scope: 'destructive-admin' });
  });

  it('Tab stays inside the dialog (input → Cancel → Continue → input)', async () => {
    const pending = obtainStepUp(refusal, null, { send: vi.fn(), signInAgain: vi.fn() });
    await waitForInput();
    const confirmButton = document.querySelector<HTMLButtonElement>('[data-product-dialog-action="confirm"]')!;
    expect(confirmButton.textContent).toBe(t('stepup_confirm'));
    confirmButton.focus();
    key(confirmButton, { key: 'Tab' });
    expect(document.activeElement).toBe(input());
    key(input(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmButton);
    closeProductDialog();
    await expect(pending).resolves.toBeNull();
  });

  it('the sign-in-again explanation is an operable dialog that focuses the safe choice first', async () => {
    const signInAgain = vi.fn();
    const pending = obtainStepUp({ ...refusal, methods: ['sign_in'] }, null, { send: vi.fn(), signInAgain });
    await vi.waitFor(() => expect(document.querySelector('.bridge-product-dialog')).not.toBeNull());
    await flush();
    const cancel = document.querySelector<HTMLButtonElement>('[data-product-dialog-action="cancel"]')!;
    expect(document.activeElement).toBe(cancel);
    expect(document.querySelector('[data-product-dialog-action="confirm"]')!.textContent).toBe(t('stepup_sign_in_again'));
    document.querySelector<HTMLButtonElement>('[data-product-dialog-action="confirm"]')!.click();
    await expect(pending).resolves.toBeNull();
    expect(signInAgain).toHaveBeenCalledTimes(1);
  });
});

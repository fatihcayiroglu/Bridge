// Canonical Bridge confirmation / text-prompt surface.
//
// Native alert()/confirm()/prompt() block the browser event loop, cannot follow
// Bridge theming, provide weak focus semantics, and behave inconsistently in
// embedded/mobile shells. Product actions should use this owner instead.
//
// Security: all caller-provided copy is assigned through textContent/value.
// No user-controlled string is inserted as HTML.

import { t } from './i18n/index.ts';
export type ProductDialogTone = 'default' | 'danger';

export interface ProductConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ProductDialogTone;
}

export interface ProductPromptOptions extends ProductConfirmOptions {
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  /**
   * `password` masks the value and offers the saved password; `one-time-code`
   * offers an authenticator code. Default `text`.
   */
  inputType?: 'text' | 'password' | 'one-time-code';
  /** Visible label bound to the input (a placeholder is not a label). */
  inputLabel?: string;
  /** Problem with the previous attempt: announced (role="alert") and tied to the input. */
  error?: string;
}

type ActiveDialog = { cancel: () => void };
let activeDialog: ActiveDialog | null = null;

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(node => !node.hasAttribute('hidden') && node.getAttribute('aria-hidden') !== 'true');
}

function mountDialog<T>(
  options: ProductConfirmOptions,
  inputOptions: ProductPromptOptions | null,
  resolveValue: (confirmed: boolean, input: HTMLInputElement | null) => T,
): Promise<T> {
  // Peer browser dialogs are mutually exclusive. A newer product decision wins
  // and the previous pending action is safely interpreted as cancelled.
  activeDialog?.cancel();

  return new Promise<T>((resolve) => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay bridge-product-dialog-overlay';
    overlay.dataset.bridgeProductDialog = 'true';

    const card = document.createElement('section');
    card.className = 'modal-card bridge-product-dialog';
    card.setAttribute('role', options.tone === 'danger' ? 'alertdialog' : 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.tabIndex = -1;

    const titleId = `bridge-product-dialog-title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messageId = `${titleId}-message`;

    const title = document.createElement('h2');
    title.id = titleId;
    title.textContent = options.title || t('product_confirm_title');
    card.setAttribute('aria-labelledby', titleId);

    const message = document.createElement('p');
    message.id = messageId;
    message.className = 'bridge-product-dialog-message';
    message.textContent = String(options.message ?? '');
    message.style.whiteSpace = 'pre-line';
    card.setAttribute('aria-describedby', messageId);

    let input: HTMLInputElement | null = null;
    let label: HTMLLabelElement | null = null;
    let problem: HTMLParagraphElement | null = null;
    if (inputOptions) {
      input = document.createElement('input');
      input.id = `${titleId}-input`;
      input.className = 'input bridge-product-dialog-input';
      input.type = inputOptions.inputType === 'password' ? 'password' : 'text';
      input.value = String(inputOptions.initialValue ?? '');
      input.placeholder = String(inputOptions.placeholder ?? '');
      input.maxLength = Math.max(1, Math.min(1024, Number(inputOptions.maxLength) || 256));
      input.autocomplete = inputOptions.inputType === 'password' ? 'current-password'
        : inputOptions.inputType === 'one-time-code' ? 'one-time-code' : 'off';
      input.spellcheck = false;
      if (inputOptions.inputType === 'one-time-code') input.setAttribute('autocapitalize', 'off');
      if (inputOptions.inputLabel) {
        label = document.createElement('label');
        label.className = 'bridge-product-dialog-label';
        label.htmlFor = input.id;
        label.textContent = String(inputOptions.inputLabel);
      }
      if (inputOptions.error) {
        problem = document.createElement('p');
        problem.id = `${titleId}-error`;
        problem.className = 'bridge-product-dialog-error';
        problem.setAttribute('role', 'alert');
        problem.textContent = String(inputOptions.error);
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', problem.id);
      }
    }

    const footer = document.createElement('div');
    footer.className = 'modal-footer bridge-product-dialog-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn btn-secondary';
    cancelButton.dataset.productDialogAction = 'cancel';
    cancelButton.textContent = options.cancelLabel || t('vp_cancel');

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = options.tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    confirmButton.dataset.productDialogAction = 'confirm';
    confirmButton.textContent = options.confirmLabel || t('confirm');

    footer.append(cancelButton, confirmButton);
    card.append(title, message);
    if (label) card.append(label);
    if (input) card.append(input);
    if (problem) card.append(problem);
    card.append(footer);
    overlay.append(card);

    let settled = false;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      if (activeDialog?.cancel === cancel) activeDialog = null;
      overlay.removeEventListener('keydown', onKeyDown);
      overlay.removeEventListener('click', onOverlayClick);
      overlay.remove();
      const value = resolveValue(confirmed, input);
      queueMicrotask(() => {
        if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
      });
      resolve(value);
    };
    const cancel = (): void => finish(false);

    const onOverlayClick = (event: MouseEvent): void => {
      if (event.target === overlay) finish(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      if (event.key === 'Enter' && input && event.target === input) {
        event.preventDefault();
        finish(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables(card);
      if (!items.length) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    cancelButton.addEventListener('click', () => finish(false));
    confirmButton.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', onOverlayClick);
    overlay.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
    activeDialog = { cancel };

    queueMicrotask(() => {
      if (input) {
        input.focus({ preventScroll: true });
        input.select();
      } else {
        // Safer default for destructive choices: focus Cancel, not Delete.
        cancelButton.focus({ preventScroll: true });
      }
    });
  });
}

export function confirmProductAction(options: ProductConfirmOptions): Promise<boolean> {
  return mountDialog(options, null, confirmed => confirmed);
}

export function promptProductText(options: ProductPromptOptions): Promise<string | null> {
  return mountDialog(options, options, (confirmed, input) => confirmed ? (input?.value ?? '') : null);
}

export function closeProductDialog(): void {
  activeDialog?.cancel();
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  closeProductDialog,
  confirmProductAction,
  promptProductText,
} from '../js/core/product-dialog.ts';
import { t } from '../js/core/i18n/index.ts';

const overlay = (): HTMLElement | null => document.querySelector('.bridge-product-dialog-overlay');
const card = (): HTMLElement => document.querySelector('.bridge-product-dialog')!;
const input = (): HTMLInputElement | null => document.querySelector('.bridge-product-dialog-input');
const action = (name: 'confirm' | 'cancel'): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${name}"]`)!;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  closeProductDialog();
  document.body.innerHTML = '';
});

describe('product dialog structure and copy', () => {
  it('default tone renders a dialog with translated title/labels and no input', async () => {
    const pending = confirmProductAction({ message: 'Kanalı arşivle?' });
    await flush();

    expect(card().getAttribute('role')).toBe('dialog');
    expect(card().getAttribute('aria-modal')).toBe('true');
    expect(card().tabIndex).toBe(-1);
    expect(input()).toBeNull();
    expect(card().querySelector('h2')!.textContent).toBe(t('product_confirm_title'));
    expect(action('cancel').textContent).toBe(t('vp_cancel'));
    expect(action('confirm').textContent).toBe(t('confirm'));
    expect(action('confirm').className).toBe('btn btn-primary');

    const message = card().querySelector('.bridge-product-dialog-message')!;
    expect(message.textContent).toBe('Kanalı arşivle?');
    // Çok satırlı uyarılar tek satıra ezilmemeli.
    expect((message as HTMLElement).style.whiteSpace).toBe('pre-line');
    // aria bağları başlık ve mesaja işaret eder.
    expect(card().getAttribute('aria-labelledby')).toBe(card().querySelector('h2')!.id);
    expect(card().getAttribute('aria-describedby')).toBe(message.id);

    action('cancel').click();
    expect(await pending).toBe(false);
  });

  it('danger tone becomes an alertdialog with a danger confirm button and custom labels', async () => {
    const pending = confirmProductAction({
      title: 'Sunucuyu sil',
      message: 'Bu işlem geri alınamaz.',
      confirmLabel: 'Sil',
      cancelLabel: 'Vazgeç',
      tone: 'danger',
    });
    await flush();

    expect(card().getAttribute('role')).toBe('alertdialog');
    expect(card().querySelector('h2')!.textContent).toBe('Sunucuyu sil');
    expect(action('confirm').className).toBe('btn btn-danger');
    expect(action('confirm').textContent).toBe('Sil');
    expect(action('cancel').textContent).toBe('Vazgeç');
    // Yıkıcı seçimde odak varsayılan olarak İptal'de durur.
    expect(document.activeElement).toBe(action('cancel'));

    action('confirm').click();
    expect(await pending).toBe(true);
  });

  it('caller copy is never interpreted as markup', async () => {
    const pending = confirmProductAction({
      title: '<img src=x onerror=alert(1)>',
      message: '<script>alert(2)</script>',
      confirmLabel: '<b>ok</b>',
    });
    await flush();

    expect(card().querySelector('img')).toBeNull();
    expect(card().querySelector('script')).toBeNull();
    expect(card().querySelector('b')).toBeNull();
    expect(card().querySelector('h2')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(action('confirm').textContent).toBe('<b>ok</b>');

    closeProductDialog();
    expect(await pending).toBe(false);
  });

  it('prompt input carries initial value, placeholder and a clamped maxLength', async () => {
    for (const [maxLength, expected] of [
      [undefined, 256], [0, 256], [Number.NaN, 256], ['abc', 256],
      [-5, 1], [32, 32], [5_000, 1024],
    ] as const) {
      const pending = promptProductText({
        message: 'Süre gir',
        initialValue: '2h',
        placeholder: 'örn. 30m',
        maxLength: maxLength as number | undefined,
      });
      await flush();

      expect(input()!.value).toBe('2h');
      expect(input()!.placeholder).toBe('örn. 30m');
      expect(input()!.type).toBe('text');
      expect(input()!.autocomplete).toBe('off');
      expect(input()!.spellcheck).toBe(false);
      expect(input()!.maxLength).toBe(expected);
      // Metin istemlerinde odak doğrudan alana gider ve içerik seçili gelir.
      expect(document.activeElement).toBe(input());

      closeProductDialog();
      expect(await pending).toBeNull();
    }
  });

  it('missing message/initialValue/placeholder degrade to empty strings, not "undefined"', async () => {
    const pending = promptProductText({ message: undefined as unknown as string });
    await flush();

    expect(card().querySelector('.bridge-product-dialog-message')!.textContent).toBe('');
    expect(input()!.value).toBe('');
    expect(input()!.placeholder).toBe('');

    action('confirm').click();
    expect(await pending).toBe('');
  });
});

describe('product dialog resolution paths', () => {
  it('confirm returns the current input text; cancel returns null instead of the text', async () => {
    const confirmed = promptProductText({ message: 'Ad', initialValue: 'eski' });
    await flush();
    input()!.value = 'yeni';
    action('confirm').click();
    expect(await confirmed).toBe('yeni');

    const cancelled = promptProductText({ message: 'Ad', initialValue: 'eski' });
    await flush();
    input()!.value = 'yazıldı ama onaylanmadı';
    action('cancel').click();
    expect(await cancelled).toBeNull();
  });

  it('the overlay is torn down once: repeated clicks cannot resolve a second value', async () => {
    let settledCount = 0;
    const pending = confirmProductAction({ message: 'tek sefer' }).then((value) => {
      settledCount += 1;
      return value;
    });
    await flush();
    const node = overlay()!;
    const confirmButton = action('confirm');
    const cancelButton = action('cancel');

    confirmButton.click();
    // Düğmeler DOM'dan koptuktan sonra bile ikinci bir sonuç üretemez.
    cancelButton.click();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    key(node, { key: 'Escape' });

    expect(await pending).toBe(true);
    await flush();
    expect(settledCount).toBe(1);
    expect(overlay()).toBeNull();
  });

  it('clicking the backdrop cancels, clicking inside the card does not', async () => {
    const pending = confirmProductAction({ message: 'arka plan' });
    await flush();
    const node = overlay()!;

    card().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(overlay()).not.toBeNull();

    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await pending).toBe(false);
    expect(overlay()).toBeNull();
  });

  it('Escape cancels and stops the event so host surfaces do not also close', async () => {
    const seenByHost: string[] = [];
    document.addEventListener('keydown', event => seenByHost.push(event.key));
    const pending = confirmProductAction({ message: 'kaçış' });
    await flush();

    const event = key(overlay()!, { key: 'Escape' });
    expect(event.defaultPrevented).toBe(true);
    expect(await pending).toBe(false);
    expect(seenByHost).toEqual([]);
    document.removeEventListener('keydown', event2 => seenByHost.push(event2.key));
  });

  it('Enter confirms only from the prompt input, not from other targets', async () => {
    const fromButton = promptProductText({ message: 'enter', initialValue: 'x' });
    await flush();
    key(action('cancel'), { key: 'Enter' });
    await flush();
    expect(overlay()).not.toBeNull();
    closeProductDialog();
    expect(await fromButton).toBeNull();

    const fromInput = promptProductText({ message: 'enter', initialValue: 'x' });
    await flush();
    const event = key(input()!, { key: 'Enter' });
    expect(event.defaultPrevented).toBe(true);
    expect(await fromInput).toBe('x');

    // Girdisi olmayan onay diyaloğunda Enter özel bir yol değildir.
    const confirmOnly = confirmProductAction({ message: 'enter' });
    await flush();
    key(action('confirm'), { key: 'Enter' });
    await flush();
    expect(overlay()).not.toBeNull();
    closeProductDialog();
    expect(await confirmOnly).toBe(false);
  });

  it('a newer dialog supersedes the pending one, which resolves as cancelled', async () => {
    const first = promptProductText({ message: 'birinci', initialValue: 'a' });
    await flush();
    const second = confirmProductAction({ message: 'ikinci' });
    await flush();

    expect(await first).toBeNull();
    expect(document.querySelectorAll('.bridge-product-dialog-overlay')).toHaveLength(1);
    expect(card().querySelector('.bridge-product-dialog-message')!.textContent).toBe('ikinci');

    action('confirm').click();
    expect(await second).toBe(true);
    // Kapanan diyalog kayıt dışı bırakılır: sonraki closeProductDialog çağrısı sessizdir.
    expect(() => closeProductDialog()).not.toThrow();
  });

  it('closeProductDialog is a no-op when nothing is open', () => {
    expect(() => closeProductDialog()).not.toThrow();
    expect(overlay()).toBeNull();
  });
});

describe('product dialog focus containment', () => {
  it('Tab wraps between the first and last focusable control', async () => {
    const pending = promptProductText({ message: 'odak', initialValue: 'a' });
    await flush();
    const first = input()!;
    const last = action('confirm');

    first.focus();
    const forwardFromMiddle = key(first, { key: 'Tab' });
    // Ortadaki eleman tarayıcının doğal sırasına bırakılır.
    expect(forwardFromMiddle.defaultPrevented).toBe(false);

    const backward = key(first, { key: 'Tab', shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    const forward = key(last, { key: 'Tab' });
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    closeProductDialog();
    expect(await pending).toBeNull();
  });

  it('non-Tab keys are left alone', async () => {
    const pending = confirmProductAction({ message: 'harf' });
    await flush();
    const event = key(overlay()!, { key: 'a' });
    expect(event.defaultPrevented).toBe(false);
    expect(overlay()).not.toBeNull();
    closeProductDialog();
    expect(await pending).toBe(false);
  });

  it('hidden and aria-hidden controls are skipped when computing the focus ring', async () => {
    const pending = promptProductText({ message: 'gizli', initialValue: 'a' });
    await flush();
    action('cancel').setAttribute('aria-hidden', 'true');
    const decoy = document.createElement('button');
    decoy.setAttribute('hidden', '');
    card().append(decoy);

    input()!.focus();
    const backward = key(input()!, { key: 'Tab', shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    // Gizli düğmeler halkaya girmez: son odaklanabilir eleman Onayla'dır.
    expect(document.activeElement).toBe(action('confirm'));

    closeProductDialog();
    expect(await pending).toBeNull();
  });

  it('with every control unfocusable, Tab parks focus on the card instead of escaping the dialog', async () => {
    const pending = confirmProductAction({ message: 'boş halka' });
    await flush();
    action('cancel').disabled = true;
    action('confirm').disabled = true;

    const event = key(overlay()!, { key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(card());

    closeProductDialog();
    expect(await pending).toBe(false);
  });

  it('focus returns to the opener, and a removed opener does not throw', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const restored = confirmProductAction({ message: 'geri dön' });
    await flush();
    action('cancel').click();
    expect(await restored).toBe(false);
    await flush();
    expect(document.activeElement).toBe(opener);

    const detachedOpener = document.createElement('button');
    document.body.append(detachedOpener);
    detachedOpener.focus();
    const pending = confirmProductAction({ message: 'kopmuş açıcı' });
    await flush();
    detachedOpener.remove();
    action('confirm').click();
    expect(await pending).toBe(true);
    await flush();
    expect(document.body.contains(detachedOpener)).toBe(false);
  });
});

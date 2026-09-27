// client/js/core/a11y/focusTrap.ts
// FAZ E — KANONİK ODAK YÖNETİMİ İLKELİ (tek sahip).
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BİR ACTION, BİLEŞEN DEĞİL
// ════════════════════════════════════════════════════════════════════════════
// Canlı diyaloglar zaten role="dialog" taşıyan div'ler olarak var. Bileşen
// sarmalayıcı her yüzeyin işaretlemesini yeniden yapılandırmayı ve
// display:contents bir ara katman eklemeyi gerektirirdi. Action doğrudan
// mevcut düğüme takılır: use:focusTrap={{ active: isVisible }}
//
// ════════════════════════════════════════════════════════════════════════════
// TEK BELGE DİNLEYİCİSİ + YIĞIN (İÇ İÇE DİYALOG ÖNCELİĞİ)
// ════════════════════════════════════════════════════════════════════════════
// Tab GENEL olarak ele geçirilmez: sarma mantığı DÜĞÜMÜN kendi keydown'ında
// çalışır. Ancak odak düğümün dışına kaçabilir (programatik focus(), tarayıcı
// arayüzünden dönüş). Bunu yakalamak için belge seviyesinde TEK bir focusin
// gözcüsü vardır — her tuzak için bir tane DEĞİL. Böylece "birbiriyle kavga
// eden birden çok belge tuzağı" durumu YAPISAL olarak imkânsızdır.
//
// Aynı anda birden çok tuzak etkinse yalnızca YIĞININ TEPESİ uygular. İç içe
// modal açıldığında kendi tuzağı tepeye biner; kapandığında altındaki yeniden
// yetkili olur. GDM'de modallar panelin KARDEŞİ olarak render edilir (panelin
// içinde değil), bu yüzden contains() tabanlı öncelik doğru sonucu verir.

/** Odaklanabilir aday seçicisi. [disabled] ve tabindex="-1" dışlanır. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'details > summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

export interface FocusTrapOptions {
  /** Tuzak etkin mi. Genelde panelin isVisible durumu bağlanır. */
  active?: boolean;
  /** Açılışta odaklanacak öğe için düğüm İÇİ CSS seçici (ör. 'input'). */
  initialFocus?: string;
  /** Kapanışta odağın açan öğeye iadesi. Varsayılan: true. */
  returnFocus?: boolean;
}

interface TrapInstance {
  node: HTMLElement;
  opener: HTMLElement | null;
  initialFocus?: string;
  returnFocus: boolean;
}

/** Etkin tuzaklar — SON eleman tepedir ve tek uygulayıcıdır. */
const stack: TrapInstance[] = [];
let guardAttached = false;

/**
 * Görünürlük denetimi.
 *
 * offsetParent tek başına yetmez: position:fixed öğelerde null olabilir — ki
 * modallar tam da fixed'dir. Bu yüzden client rect'leri kontrol edilir.
 */
function isRendered(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden')) return false;
  if (el.closest('[hidden]')) return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  if (el.closest('[inert]')) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
  return true;
}

/**
 * Düğüm içindeki GERÇEKTEN odaklanabilir öğeler — KESİN BELGE SIRASINDA.
 *
 * ⚠ BURADA `querySelectorAll(FOCUSABLE_SELECTOR)` KULLANILMAZ.
 *
 * Virgülle ayrılmış bir seçici listesi verildiğinde, uygulamalar sonucu her
 * zaman belge sırasında döndürmez: jsdom'un altındaki nwsapi, seçici listesi
 * yeterince karmaşık olduğunda (ör. `input:not([disabled]):not([type=...])`)
 * ALT SEÇİCİ BAZINDA gruplayarak döndürebiliyor — önce tüm `button` eşleşmeleri,
 * sonra tüm `input` eşleşmeleri. Bu, Tab sırasını sessizce BOZAR: ölçümde
 * kapatma düğmesi belge sırasında SON iken listede 6. sıraya düşüyordu, bu
 * yüzden "son öğede Tab → başa sar" davranışı hiç tetiklenmiyordu.
 *
 * `querySelectorAll('*')` belge sırasını garanti eder; eşleştirme öğe başına
 * `matches()` ile yapılır. Modal alt ağaçları küçük olduğu için maliyeti
 * önemsizdir — doğruluk burada hızdan önce gelir.
 */
export function getFocusable(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>('*'))
    .filter(el => el.matches(FOCUSABLE_SELECTOR))
    .filter(el => !el.hasAttribute('disabled'))
    // `tabindex="-1"` AYRI bir süzgeç olmak ZORUNDA.
    //
    // Seçici listesi bir VEYA'dır: `<button tabindex="-1">` öğesi
    // `button:not([disabled])` ile eşleşir ve `[tabindex]:not([tabindex="-1"])`
    // maddesi onu ELEMEZ — çünkü eleme değil, ayrı bir eşleşme dalıdır.
    // Oysa `tabindex="-1"` "yalnızca programatik olarak odaklanabilir,
    // Tab sırasında YER ALMAZ" demektir.
    .filter(el => el.getAttribute('tabindex') !== '-1')
    .filter(el => el.getAttribute('aria-hidden') !== 'true')
    .filter(isRendered);
}

/**
 * Odağı tuzağın içine taşır.
 *
 * Odaklanabilir öğe YOKSA kabın kendisi odaklanır (gerekiyorsa tabindex="-1"
 * eklenerek). Bu, "boş modal" durumunda odağın arka plana düşmesini önler —
 * aksi hâlde tuzak sessizce ETKİSİZ olurdu.
 */
function focusInside(inst: TrapInstance): void {
  const { node, initialFocus } = inst;

  if (initialFocus) {
    const preferred = node.querySelector<HTMLElement>(initialFocus);
    if (preferred && isRendered(preferred)) { preferred.focus(); return; }
  }

  const focusable = getFocusable(node);
  if (focusable.length > 0) { focusable[0]!.focus(); return; }

  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.focus();
}

/** Yalnız TEPEDEKİ tuzak için: odak dışarı kaçtıysa geri çeker. */
function onDocumentFocusIn(e: FocusEvent): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  const target = e.target as Node | null;
  if (!target) return;
  // Düğüm DOM'dan koptuysa tuzak uygulanamaz; bırak.
  if (!top.node.isConnected) return;
  if (top.node.contains(target)) return;
  focusInside(top);
}

function attachGuard(): void {
  if (guardAttached) return;
  document.addEventListener('focusin', onDocumentFocusIn, true);
  guardAttached = true;
}

function detachGuardIfIdle(): void {
  if (stack.length > 0 || !guardAttached) return;
  document.removeEventListener('focusin', onDocumentFocusIn, true);
  guardAttached = false;
}

/** Tab / Shift+Tab sarmalama — DÜĞÜM seviyesinde, genel ele geçirme YOK. */
function onNodeKeyDown(this: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const top = stack[stack.length - 1];
  // Yalnız tepedeki tuzak uygular: iç içe modalde alttaki sarmalamamalıdır.
  if (!top || top.node !== this) return;

  const focusable = getFocusable(this);
  if (focusable.length === 0) {
    // Odaklanacak hiçbir şey yok — Tab'ı yut, odak arka plana GİTMESİN.
    e.preventDefault();
    focusInside(top);
    return;
  }

  const first = focusable[0]!;
  const last  = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  const inside = this.contains(active);

  if (e.shiftKey) {
    if (active === first || !inside) { e.preventDefault(); last.focus(); }
  } else {
    if (active === last || !inside) { e.preventDefault(); first.focus(); }
  }
}

function activate(inst: TrapInstance): void {
  if (stack.includes(inst)) return;
  // Açan öğeyi tuzak ETKİNLEŞMEDEN ÖNCE yakala.
  const active = document.activeElement as HTMLElement | null;
  inst.opener = active && active !== document.body ? active : null;
  stack.push(inst);
  attachGuard();
  focusInside(inst);
}

function deactivate(inst: TrapInstance): void {
  const i = stack.indexOf(inst);
  if (i === -1) return;
  stack.splice(i, 1);
  detachGuardIfIdle();

  if (!inst.returnFocus) { inst.opener = null; return; }

  const opener = inst.opener;
  inst.opener = null;
  // Açan öğe kapanmadan önce DOM'dan kaldırılmış olabilir (ör. liste
  // yenilendi). Bağlı değilse odak iadesi DENENMEZ — kopmuş bir düğüme
  // focus() çağırmak odağı sessizce body'ye düşürürdü.
  if (opener && opener.isConnected && isRendered(opener)) opener.focus();
}

/**
 * Svelte action.
 *
 * Kullanım:
 *   <div role="dialog" aria-modal="true" use:focusTrap={{ active: isVisible }}>
 *
 * active false başlarsa hiçbir şey yapılmaz; true olduğunda etkinleşir.
 * Bileşen AÇIKKEN yok edilirse destroy() temizliği ve odak iadesini yapar.
 */
export function focusTrap(node: HTMLElement, options: FocusTrapOptions = {}) {
  const inst: TrapInstance = {
    node,
    opener: null,
    initialFocus: options.initialFocus,
    returnFocus: options.returnFocus !== false,
  };

  const handler = onNodeKeyDown.bind(node);
  node.addEventListener('keydown', handler);

  if (options.active !== false) activate(inst);

  return {
    update(next: FocusTrapOptions = {}): void {
      inst.initialFocus = next.initialFocus;
      inst.returnFocus  = next.returnFocus !== false;
      const wantActive  = next.active !== false;
      const isActive    = stack.includes(inst);
      if (wantActive && !isActive) activate(inst);
      else if (!wantActive && isActive) deactivate(inst);
    },
    destroy(): void {
      node.removeEventListener('keydown', handler);
      // Açıkken yok edilme: yığından çıkar ve odağı iade et.
      deactivate(inst);
    },
  };
}

/** Test/teşhis amaçlı: etkin tuzak sayısı. Üretim mantığı buna DAYANMAZ. */
export function _activeTrapCount(): number {
  return stack.length;
}

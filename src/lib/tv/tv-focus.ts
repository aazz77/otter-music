import { registerPlugin } from "@capacitor/core";
import { useMusicStore } from "@/store/music-store";
import { logger } from "@/lib/logger";

/**
 * TV 遥控器焦点导航引擎（Web 端）
 *
 * 参照 Lumio 的原生 TvFocusableLayout / FocusFinder 方案，
 * 在 Capacitor WebView 中等价实现：
 * - 原生 TvFocusableLayout 画焦点边框  → CSS `.tv-mode :focus` 外框
 * - Android FocusFinder 方向搜索       → JS 空间导航（beam + 距离评分）
 * - DPAD_CENTER → performClick → topPress → Enter：原生可激活元素走默认行为，
 *   cursor-pointer 的 div 走「中心点合成 click」（bubbles 冒泡触发 React onClick）
 * - MainActivity 广播媒体键            → WebView 直接派发 DOM keydown，JS 侧接住
 */

interface TvFocusPluginInterface {
  isTv(): Promise<{ isTv: boolean }>;
}

const TvFocus = registerPlugin<TvFocusPluginInterface>("TvFocus");

/** 原生可聚焦/可交互元素 */
const STRONG_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[tabindex]",
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="link"]',
  '[data-tv-focusable]',
].join(",");

/** 光标为 pointer 的 Tailwind 元素（如 MusicTrackItem 的行 div） */
const POINTER_SELECTOR = ".cursor-pointer";

/** 这些元素获得焦点时应由组件自身处理方向键（slider 调音量、select/radix 菜单导航、输入框移动光标） */
const SELF_NAVIGATED_ROLE = new Set([
  "slider",
  "option",
  "combobox",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "radiogroup",
  "listbox",
  "textbox",
]);

const NATIVE_ACTIVATABLE_SELECTOR =
  "button, a[href], input, select, textarea, summary, label";

const ARROW_DIRS: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const MEDIA_KEYS = new Set([
  "MediaPlayPause",
  "MediaPlay",
  "MediaPause",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "MediaStop",
]);

type Dir = "up" | "down" | "left" | "right";

let inited = false;
let initPromise: Promise<void> | null = null;
let retryTimer: number | null = null;

// ---------------------------------------------------------------------------
// TV 设备检测
// ---------------------------------------------------------------------------

async function detectTv(): Promise<boolean> {
  try {
    const { isTv } = await TvFocus.isTv();
    return isTv;
  } catch {
    // Web 平台或旧版原生壳：退化为注入标志 + UA 判断
    if ((window as unknown as { __OTTER_TV__?: boolean }).__OTTER_TV__) {
      return true;
    }
    return /Android.*[;)]\s*TV|GoogleTV/i.test(navigator.userAgent);
  }
}

export function isTvModeEnabled(): boolean {
  return inited;
}

// ---------------------------------------------------------------------------
// 初始化入口
// ---------------------------------------------------------------------------

export function initTvFocus(): Promise<void> {
  // 单例化，避免 StrictMode 双挂载重复注册监听
  if (!initPromise) initPromise = doInitTvFocus();
  return initPromise;
}

async function doInitTvFocus(): Promise<void> {
  if (inited) return;

  const isTv = await detectTv();
  if (!isTv) return;

  inited = true;
  document.documentElement.classList.add("tv-mode");
  logger.info("TvFocus", "TV 模式已启用，启用遥控器焦点导航");

  // capture 阶段监听，避免被列表虚拟化容器等的 stopPropagation 吞掉
  window.addEventListener("keydown", onKeyDown, true);
}

// ---------------------------------------------------------------------------
// 按键分发
// ---------------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent) {
  if (MEDIA_KEYS.has(e.key)) {
    e.preventDefault();
    handleMediaKey(e.key);
    return;
  }

  const dir = ARROW_DIRS[e.key];
  if (dir) {
    if (shouldSkipNavigation()) return;
    e.preventDefault();
    e.stopPropagation();
    moveFocus(dir);
    return;
  }

  if (e.key === "Enter" && !shouldSkipNavigation()) {
    handleEnter(e);
  }
}

/** 焦点元素自身需要方向键/回车时让出控制权 */
function shouldSkipNavigation(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;

  if (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  ) {
    return true;
  }

  const role = el.getAttribute("role");
  if (role && SELF_NAVIGATED_ROLE.has(role)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// 候选元素收集
// ---------------------------------------------------------------------------

function currentScope(): HTMLElement | null {
  // 1) 显式标记的作用域（如全屏播放器的 portal 根节点）
  const scopes = document.querySelectorAll<HTMLElement>(
    "[data-tv-focus-scope]"
  );
  for (let i = scopes.length - 1; i >= 0; i--) {
    const el = scopes[i];
    const r = el.getBoundingClientRect();
    if (r.width > 100 && r.height > 100 && r.bottom > 0 && r.top < window.innerHeight) {
      return el;
    }
  }

  // 2) 打开中的对话框（radix Dialog / vaul Drawer）收窄作用域，焦点锁在弹层内
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const d = dialogs[i];
    const r = d.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return d;
  }
  return null;
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;

  // 必须与视口相交（离屏元素不参与搜索，配合滚动兜底逐屏探索）
  if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
  if (r.right <= 0 || r.left >= window.innerWidth) return false;

  const style = getComputedStyle(el);
  if (
    style.visibility === "hidden" ||
    style.display === "none" ||
    style.pointerEvents === "none"
  ) {
    return false;
  }
  return true;
}

function collectCandidates(): HTMLElement[] {
  const scope = currentScope() ?? document.body;
  const seen = new Set<HTMLElement>();
  const result: HTMLElement[] = [];

  const addIfEligible = (el: HTMLElement) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
    if (!isVisible(el)) return;
    result.push(el);
  };

  scope.querySelectorAll<HTMLElement>(STRONG_SELECTOR).forEach(addIfEligible);

  // cursor-pointer 的 div（列表行等）：跳过已收集元素的子孙，保持候选互不嵌套
  scope.querySelectorAll<HTMLElement>(POINTER_SELECTOR).forEach((el) => {
    if (seen.has(el)) return;
    // 若已被某个强选择器祖先覆盖，跳过；若包含强选择器后代也保留自身
    for (const s of seen) {
      if (s !== el && s.contains(el)) return;
    }
    addIfEligible(el);
  });

  return result;
}

function focusedCandidate(candidates: HTMLElement[]): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && candidates.includes(active)
    ? active
    : null;
}

function focusCandidate(el: HTMLElement) {
  // cursor-pointer 的 div 默认不可聚焦，按需补 tabindex（roving focus）
  if (!el.matches(STRONG_SELECTOR) && !el.hasAttribute("tabindex")) {
    el.setAttribute("tabindex", "-1");
  }
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function focusFirst(candidates: HTMLElement[]) {
  // 取视口内最靠上、最靠左的候选（对齐 Android 初始焦点习惯）
  let best: HTMLElement | null = null;
  let bestTop = Infinity;
  let bestLeft = Infinity;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.top < bestTop || (r.top === bestTop && r.left < bestLeft)) {
      bestTop = r.top;
      bestLeft = r.left;
      best = el;
    }
  }
  if (best) focusCandidate(best);
}

// ---------------------------------------------------------------------------
// 空间导航（对齐 Android FocusFinder 的 beam + 加权距离思路）
// ---------------------------------------------------------------------------

function findNextFocus(
  candidates: HTMLElement[],
  current: HTMLElement,
  dir: Dir
): HTMLElement | null {
  const cr = current.getBoundingClientRect();
  const ccx = cr.left + cr.width / 2;
  const ccy = cr.top + cr.height / 2;

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const rcx = r.left + r.width / 2;
    const rcy = r.top + r.height / 2;

    // 主轴：候选中心必须在方向上
    let primaryGap: number; // 主轴边缘间距（负值=重叠）
    let crossOverlap: number; // 副轴投影重叠量
    let inDirection: boolean;

    switch (dir) {
      case "down":
        inDirection = rcy > ccy;
        primaryGap = r.top - cr.bottom;
        crossOverlap =
          Math.min(cr.right, r.right) - Math.max(cr.left, r.left);
        break;
      case "up":
        inDirection = rcy < ccy;
        primaryGap = cr.top - r.bottom;
        crossOverlap =
          Math.min(cr.right, r.right) - Math.max(cr.left, r.left);
        break;
      case "right":
        inDirection = rcx > ccx;
        primaryGap = r.left - cr.right;
        crossOverlap =
          Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top);
        break;
      case "left":
        inDirection = rcx < ccx;
        primaryGap = cr.left - r.right;
        crossOverlap =
          Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top);
        break;
    }

    if (!inDirection) continue;

    // 主轴距离：边缘间距（贴邻为 0），重叠时按中心距折算
    const primary = primaryGap >= 0 ? primaryGap : 0;
    // 副轴：有投影重叠优先（beam），无重叠按间隙重罚
    const cross =
      crossOverlap > 0
        ? 0
        : Math.abs(crossOverlap) * 4;
    // 轻微偏向与当前元素中心对齐的候选
    const alignBias =
      dir === "up" || dir === "down"
        ? Math.abs(rcx - ccx) * 0.05
        : Math.abs(rcy - ccy) * 0.05;

    const score = primary + cross + alignBias;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// 焦点移动 + 滚动兜底
// ---------------------------------------------------------------------------

function getScrollParent(el: HTMLElement, horizontal = false): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

function moveFocus(dir: Dir, retryCount = 0) {
  const candidates = collectCandidates();
  if (candidates.length === 0) return;

  const current = focusedCandidate(candidates);
  if (!current) {
    focusFirst(candidates);
    return;
  }

  const next = findNextFocus(candidates, current, dir);
  if (next) {
    focusCandidate(next);
    return;
  }

  // 当前视口内该方向没有候选：滚动容器翻一屏后重试（适配虚拟化长列表）
  if (retryCount >= 4) return;

  const horizontal = dir === "left" || dir === "right";
  const scroller = getScrollParent(current, horizontal);
  if (!scroller) return;

  const before = horizontal ? scroller.scrollLeft : scroller.scrollTop;
  const step =
    (horizontal ? scroller.clientWidth : scroller.clientHeight) * 0.7;
  const delta =
    dir === "down" || dir === "right" ? step : -step;
  if (horizontal) scroller.scrollLeft += delta;
  else scroller.scrollTop += delta;

  const after = horizontal ? scroller.scrollLeft : scroller.scrollTop;
  if (after !== before) {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      moveFocus(dir, retryCount + 1);
    }, 80);
  }
}

// ---------------------------------------------------------------------------
// Enter（DPAD_CENTER / 遥控器 OK 键）
// ---------------------------------------------------------------------------

function handleEnter(e: KeyboardEvent) {
  const el = document.activeElement;
  // 无焦点时 activeElement 为 body/documentElement：先建立初始焦点，不触发点击
  if (
    !(el instanceof HTMLElement) ||
    el === document.body ||
    el === document.documentElement
  ) {
    const candidates = collectCandidates();
    if (candidates.length > 0) {
      e.preventDefault();
      focusFirst(candidates);
    }
    return;
  }

  // 原生可激活元素交给浏览器默认行为（Chromium 会在 Enter 时派发 click）
  if (el.matches(NATIVE_ACTIVATABLE_SELECTOR)) return;

  // div 等非原生可点击元素：在中心点合成 click，冒泡触发 React onClick
  e.preventDefault();
  activateAtCenter(el);
}

function activateAtCenter(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const target = document.elementFromPoint(cx, cy);
  const dispatchTarget =
    target instanceof HTMLElement ? target : el;
  dispatchTarget.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    })
  );
}

// ---------------------------------------------------------------------------
// 遥控器媒体键（播放/暂停/上下曲）
// ---------------------------------------------------------------------------

function handleMediaKey(key: string) {
  const s = useMusicStore.getState();
  const { queue, currentIndex, setCurrentIndexAndPlay } = s;

  switch (key) {
    case "MediaPlayPause":
      s.togglePlay();
      break;
    case "MediaPlay":
      s.setIsPlaying(true);
      break;
    case "MediaPause":
      s.setIsPlaying(false);
      break;
    case "MediaTrackNext":
      if (queue.length > 0 && currentIndex < queue.length - 1) {
        setCurrentIndexAndPlay(currentIndex + 1);
      }
      break;
    case "MediaTrackPrevious":
      if (queue.length > 0 && currentIndex > 0) {
        setCurrentIndexAndPlay(currentIndex - 1);
      }
      break;
    case "MediaStop":
      s.setIsPlaying(false);
      break;
  }
}

// ---------------------------------------------------------------------------
// 路由切换后的初始焦点
// ---------------------------------------------------------------------------

/** 路由变化后调用：若无焦点则聚焦页面首个候选元素 */
export function refocusTvAfterRouteChange(): void {
  if (!inited) return;
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) return;
    // 焦点随旧 DOM 卸载丢失时，重新建立初始焦点
    const candidates = collectCandidates();
    if (candidates.length > 0) focusFirst(candidates);
  }, 250);
}

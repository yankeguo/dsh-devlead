/**
 * Plugin-owned CSS for the DevLeadBar dock.
 *
 * The package deliberately ships no CSS Modules build chain: `apply()` injects
 * this string once into `document.head` as a `<style data-plugin-css="devlead">`
 * tag. Class names are plain, globally unique hyphenated names. Colors lean on
 * the harness theme tokens (`--dsw-*` / `--dsh-*`) with neutral CSS fallbacks so
 * the strip follows light/dark themes, and degrades to readable browser colors
 * if a token is ever missing.
 */

/** Attribute marking this plugin's injected style tag. */
const STYLE_ATTRIBUTE = 'data-plugin-css'

/** Value of {@link STYLE_ATTRIBUTE} owned by this plugin. */
const STYLE_KEY = 'devlead'

/** Global stylesheet of the DevLeadBar dock. */
export const styles = `
/* Composer-tool row control: the 28px round glyph seat of the shipped attach
   and mode controls, so the off-state entry reads as one of them. */
.devlead-toggle {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary, GrayText);
}

@media (hover: hover) {
  .devlead-toggle:hover:not(:disabled) {
    color: var(--dsw-alias-label-secondary, GrayText);
  }
}

.devlead-toggle[data-devlead-failed="true"] {
  color: var(--dsw-alias-state-error-primary, #c0392b);
}

.devlead-dock {
  box-sizing: border-box;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-dock-inset, 8px) -
    var(--dsh-composer-dock-inset, 8px) -
    var(--dsh-composer-dock-inset, 8px) -
    var(--dsh-composer-dock-inset, 8px)
  );
  max-width: calc(var(--dsh-composer-card-max-width, 952px) - 4 * var(--dsh-composer-dock-inset, 8px));
  margin: 0 auto;
}

/* Menu-surface card: the composer context-stack geometry and elevation triple
   (stroke + soft light) rather than an extra CSS border, which would double the
   hairline and add layout width; the blur needs the surface on a background
   layer, so it is painted by the pseudo-element behind the content. */
.devlead-bar {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  margin: 0 auto;
  padding: 4px 6px 4px 12px;
  border: 0;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-md, 10px);
  box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 13px;
  line-height: 20px;
  font-family: inherit;
}

.devlead-bar::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background: var(--dsw-specific-menu, Canvas);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  content: '';
  pointer-events: none;
}

.devlead-glyph {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-label {
  flex: none;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, CanvasText);
  white-space: nowrap;
}

.devlead-switch {
  flex: none;
}

.devlead-meta {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 10px;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.devlead-watched {
  flex: none;
}

.devlead-running {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.devlead-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-dot[data-active="true"] {
  background: var(--dsw-alias-state-success-primary, #2e7d32);
}

.devlead-missing {
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

/* One stable live region wrapping the hint or the latest-notification chip so
   assistive technology announces a new notification as a content change of an
   existing region, not as a freshly inserted one. */
.devlead-notice {
  display: inline-flex;
  flex: 1 1 auto;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.devlead-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-notification {
  display: inline-flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, GrayText);
  white-space: nowrap;
}

.devlead-notification-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-notification-dot[data-transition="completed"] {
  background: var(--dsw-alias-state-success-primary, #2e7d32);
}

.devlead-notification-dot[data-transition="error"] {
  background: var(--dsw-alias-state-error-primary, #c0392b);
}

.devlead-notification-dot[data-transition="blocked"],
.devlead-notification-dot[data-transition="max-tokens"] {
  background: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-notification-who {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary-dimmed, rgba(127, 127, 127, 0.9));
  text-overflow: ellipsis;
}

.devlead-notification-turn,
.devlead-notification-label {
  flex: none;
}

.devlead-notification-error {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-state-error-primary, #c0392b);
  font-size: 12px;
  text-overflow: ellipsis;
}

.devlead-error {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-state-error-primary, #c0392b);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Visually hidden but announced: the compact toolbar surface has no inline
   error seat, so its failure text is mirrored into a live region through this
   class (the shipped visually-hidden idiom used by the chat surfaces). */
.devlead-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Sidebar Session-row mark: a non-interactive glyph after the row's time
   label. The seat is inline inside the row's 20px line box, so the icon can
   never change the row height or the title's ellipsis width. */
.devlead-row-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--dsw-alias-label-secondary, GrayText);
}

/* Hover-card line explaining the mark; mirrors the shell's hover status rows
   (12px text on a 20px line) so the card keeps one rhythm. */
.devlead-row-hover {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, GrayText);
}

.devlead-row-hover-glyph {
  display: inline-flex;
  flex: none;
  align-items: center;
}
`

/**
 * Realm-wide key of the stylesheet injection refcount.
 *
 * `Symbol.for` is deliberate: a client-plugin hot update re-evaluates this
 * module, so the page can hold two module instances at once and both must count
 * the same tag. A module-local `Symbol()` would give each instance its own
 * counter, and the old instance's disposer would delete the tag the new one is
 * still using. The state hangs off `globalThis` for the same reason: module
 * bindings die with re-evaluation, the realm's global object does not.
 */
const STYLE_TAG_STATE = Symbol.for('@yankeguo/dsh-client-ui-devlead.style-tag')

/** Realm-wide refcount of the injected stylesheet. */
interface DevLeadStyleTagState {
  /** Live `ensureStyleTag()` calls that have not disposed yet. */
  refs: number
  /** Tag this refcount installed or adopted, while one is known. */
  element: HTMLStyleElement | undefined
}

/** Shape of the `globalThis` record holding {@link DevLeadStyleTagState}. */
type DevLeadStyleTagStore = Record<symbol, DevLeadStyleTagState | undefined>

/**
 * The realm-wide refcount, created on first use.
 * @returns the shared injection state.
 */
function styleTagState(): DevLeadStyleTagState {
  const store = globalThis as unknown as DevLeadStyleTagStore
  const existing = store[STYLE_TAG_STATE]
  if (existing !== undefined) return existing
  const created: DevLeadStyleTagState = { refs: 0, element: undefined }
  store[STYLE_TAG_STATE] = created
  return created
}

/**
 * Resolve the tag the refcount owns: the known connected tag when possible,
 * otherwise a matching tag already in the document (one an older module
 * instance installed), otherwise a fresh one.
 * @param state - shared injection state.
 * @returns the tag to write the current stylesheet into.
 */
function resolveStyleTag(state: DevLeadStyleTagState): HTMLStyleElement {
  const known = state.element
  if (known !== undefined && known.isConnected) return known
  const adopted = document.head.querySelector<HTMLStyleElement>(
    `style[${STYLE_ATTRIBUTE}="${STYLE_KEY}"]`,
  )
  if (adopted !== null) return adopted
  const created = document.createElement('style')
  created.setAttribute(STYLE_ATTRIBUTE, STYLE_KEY)
  document.head.appendChild(created)
  return created
}

/**
 * Reference-count the plugin stylesheet injection.
 *
 * The first live call installs `<style data-plugin-css="devlead">`; later calls
 * reuse (and, after a hot update changed the stylesheet, refresh) that tag and
 * add one reference. Every disposer releases exactly one reference — even when
 * called more than once — and the tag is removed only when the last live
 * reference goes away, so an old module instance's teardown can never delete a
 * tag a newer instance is still using. A matching tag found in the document
 * without shared state tracking (written by an older module version) is adopted
 * and reused instead of duplicated.
 * @returns idempotent disposer releasing one reference to the injected tag.
 */
export function ensureStyleTag(): () => void {
  if (typeof document === 'undefined') return () => {}
  const state = styleTagState()
  const element = resolveStyleTag(state)
  state.element = element
  state.refs += 1
  // A reused or adopted tag may carry text written before a hot update changed
  // the stylesheet; the live tag must match this module instance's CSS.
  if (element.textContent !== styles) element.textContent = styles
  let released = false
  return () => {
    // React effects, plugin `ctx.effect` teardown, and HMR cleanup can race to
    // call one disposer; a double release must not steal another reference.
    if (released) return
    released = true
    state.refs = Math.max(0, state.refs - 1)
    if (state.refs > 0) return
    element.remove()
    if (state.element === element) state.element = undefined
  }
}

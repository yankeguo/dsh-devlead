/**
 * Plugin-owned CSS for the DevLead conversation surfaces: the composer-toolbar
 * toggle, the enabled-only status strip, and the sidebar marks.
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

/** Global stylesheet of the DevLead conversation surfaces. */
export const styles = `
/* Composer-tool row control: the users glyph plus a visible DevLead label. It
   keeps the 28px control height of the toolbar and sizes horizontally from its
   content, rather than occupying a fixed square glyph seat. The transparent
   1px border is part of the base box (with 1px less padding), so enabling the
   accent border changes colour only, never the control's size or the toolbar
   layout. */
.devlead-toggle {
  flex: none;
  width: auto;
  height: 28px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  gap: 6px;
  color: var(--dsw-alias-label-secondary, GrayText);
}

.devlead-toggle-label {
  flex: none;
  font-weight: 500;
  white-space: nowrap;
}

@media (hover: hover) {
  .devlead-toggle:hover:not(:disabled):not([data-devlead-failed="true"]) {
    color: var(--dsw-alias-label-primary, CanvasText);
  }
}

/* While the mode is on the same button stays in place and reads at full label
   color, with the business accent as a real border plus a very light halo.
   The halo is a box-shadow so it cannot add layout width; the border was
   already reserved (transparent) in the base rule. The failed rule below has
   the same specificity and wins the colour, so an error never leaves a blue
   accent behind. */
.devlead-toggle[data-devlead-enabled="true"] {
  color: var(--dsw-alias-label-primary, CanvasText);
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.12));
}

.devlead-toggle[data-devlead-failed="true"] {
  color: var(--dsw-alias-label-error, #c0392b);
  border-color: var(--dsw-alias-label-error, #c0392b);
  box-shadow: none;
}

/* The shell marks an active toolbar control with a subtle fill; the mode is a
   pressed toggle, not only a colour change, so mirror that affordance. */
.devlead-toggle[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

/* On a narrow viewport the visible label and the stale-watch warning would
   squeeze the composer toolbar and the status notice. The toggle keeps its
   accessible name and icon; the bar keeps the watched/running counts. */
@media (max-width: 480px) {
  .devlead-toggle {
    padding: 0 7px;
    gap: 0;
  }

  .devlead-toggle-label,
  .devlead-label,
  .devlead-missing {
    display: none;
  }

  .devlead-bar {
    gap: 6px;
    padding: 4px 10px;
  }

  .devlead-meta {
    gap: 6px;
  }
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
  min-width: 0;
  min-height: 34px;
  margin: 0 auto;
  padding: 4px 12px;
  overflow: hidden;
  border: 0;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-lg, 12px);
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
  color: var(--dsw-alias-label-secondary, GrayText);
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

.devlead-notification-dot[data-report-kind="progress"] {
  background: var(--dsw-alias-state-success-primary, #2e7d32);
}

.devlead-notification-dot[data-report-kind="blocked"] {
  background: var(--dsw-alias-state-error-primary, #c0392b);
}

.devlead-notification-dot[data-report-kind="decision"],
.devlead-notification-dot[data-report-kind="question"] {
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

/* A turn failure excerpt keeps the error ink; a report's summary/message
   detail is neutral copy — the kind dot and localized label carry the
   semantics, so progress/fyi/question text must not read as a failure. */
.devlead-notification-error,
.devlead-notification-detail {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
}

.devlead-notification-error {
  color: var(--dsw-alias-label-error, #c0392b);
}

.devlead-notification-detail {
  color: var(--dsw-alias-label-secondary, GrayText);
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

/* The active lead row gets the same business accent as the toolbar toggle,
   painted as an overlay ring so the 32px row box, padding, and title lane never
   move. Do not color or resize the shell row's border: it has a 3px transparent
   border-inline (paint inset) but no top/bottom border, and an inset box-shadow
   is clipped to the padding box, so either would look thicker/deeper on the
   left/right than on top/bottom. The ::after overlay is positioned against the
   row's border box (negative inline offsets cancel the transparent paint inset)
   and draws one 1px border plus a light outer halo on all four sides at the
   row's own radius. The row owns a stable data-row-key; :has scopes the
   decoration to exactly the active row. The status hook stays mounted while the
   shell hides the resting seat on hover, so the overlay survives hover/focus. */
[data-row-key^="session:"]:has([data-devlead-active-mark="true"]) {
  position: relative;
}

[data-row-key^="session:"]:has([data-devlead-active-mark="true"])::after {
  content: '';
  position: absolute;
  inset: 0 calc(-1 * var(--dsh-sidebar-paint-inset, 3px));
  border: 1px solid var(--dsw-alias-state-business-primary, #4176e6);
  border-radius: inherit;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.12));
  pointer-events: none;
}

/* A watched row uses a quieter shield than the active lead's mark: secondary
   ink at reduced opacity stays legible in both palettes without competing with
   the active ring. */
.devlead-row-mark-watched {
  color: var(--dsw-alias-label-secondary, GrayText);
  opacity: 0.62;
}

/* Hover-card line explaining the mark; mirrors the shell's hover status rows
   (12px text on a 20px line) so the card keeps one rhythm. */
.devlead-row-hover-active-dot {
  display: inline-block;
  flex: none;
  box-sizing: border-box;
  width: 8px;
  height: 8px;
  border: 1px solid var(--dsw-alias-state-business-primary, #4176e6);
  border-radius: 999px;
}

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

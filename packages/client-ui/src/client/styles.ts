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
.devlead-dock {
  box-sizing: border-box;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-dock-inset, 4px) -
    var(--dsh-composer-dock-inset, 4px) -
    var(--dsh-composer-dock-inset, 4px) -
    var(--dsh-composer-dock-inset, 4px)
  );
  max-width: calc(var(--dsh-composer-card-max-width, 960px) - 4 * var(--dsh-composer-dock-inset, 4px));
  margin: 0 auto;
}

.devlead-bar {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  margin: 0 auto;
  padding: 4px 6px 4px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-specific-menu, Canvas);
  box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 13px;
  line-height: 20px;
  font-family: inherit;
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
`

/**
 * Inject the plugin stylesheet once, unless an instance already exists.
 *
 * The returned disposer removes only the tag this call created: a second
 * plugin instance (or a hot reload) leaves the existing tag alone. When an
 * existing tag is reused its text is refreshed, so a client-plugin hot update
 * that changed the stylesheet does not leave the previous CSS in the page.
 * @returns idempotent disposer removing the style tag, if it was created here.
 */
export function ensureStyleTag(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.head.querySelector(`style[${STYLE_ATTRIBUTE}="${STYLE_KEY}"]`)
  if (existing !== null) {
    if (existing.textContent !== styles) existing.textContent = styles
    return () => {}
  }
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, STYLE_KEY)
  element.textContent = styles
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}

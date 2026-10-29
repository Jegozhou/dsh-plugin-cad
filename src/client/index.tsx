/**
 * dsh-plugin-cad — browser half (Cordis client plugin).
 *
 * Registered into the Harness UI, not into a web app of its own:
 *
 *  - `main` slot, keyed `dsh-plugin-cad`  → the full-size CAD page;
 *  - `sidebar.panellist`                  → the sidebar glyph that selects it.
 *
 * Everything this half adds is a Cordis effect with a disposer, so disabling or
 * uninstalling the plugin removes the dictionaries, the stylesheet, the slot
 * entries and the diagnostics hook, and the page's own unmount disposes the
 * WebGL context, RAF loop, observers and listeners. Nothing outside this
 * plugin's own route is fetched, patched or monkey-patched.
 *
 * @module client/index
 */

import * as React from 'react'
import { CadPage } from './page.tsx'
import type { PageProps } from './page.tsx'
import { CSS } from './styles.ts'
import { EN, LOCALE_NS, ZH, setTranslate, t as translate } from './locale.ts'
import type { Translate } from './locale.ts'

/** `main` slot key and `sidebar.panellist` id. */
const PANEL_ID = 'dsh-plugin-cad'
/** Client build marker visible to diagnostics/E2E. */
const CLIENT_BUILD = '0.1.0'

/** Services this half reads; Cordis gates the context on them. */
export const inject = ['locale', 'slots']

/** Minimal typed view of the documented client context. */
interface ClientContext {
  locale: {
    register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => (() => void) | void
    bind?: (namespace: string) => Translate
  }
  effect: (callback: () => void | (() => void), label?: string) => unknown
  slots: {
    inject: (name: string, callback: () => unknown) => unknown
    register: (definition: Record<string, unknown>, component: unknown) => unknown
  }
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
  }
}

/** Report a client-side problem without taking the Harness page down. */
function warn(message: string): void {
  // The client context has no guaranteed logger; console is the honest channel.
  // eslint-disable-next-line no-console
  console.warn(`[dsh-plugin-cad] ${message}`)
}

/** Run a registration inside an effect, degrading to a plain call. */
function withEffect(ctx: ClientContext, callback: () => void | (() => void), label: string): void {
  if (typeof ctx.effect === 'function') ctx.effect(callback, label)
  else callback()
}

/**
 * Sidebar glyph: an isometric solid with a section plane and three axis ticks,
 * drawn in `currentColor` so the sidebar's own hover/active colours apply.
 */
function CadIcon({ size }: { size?: number }): React.ReactElement {
  const dimension = typeof size === 'number' && Number.isFinite(size) && size > 0
    ? Math.min(64, Math.round(size))
    : 16
  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* isometric block */}
      <path d="M12 3.2 20.2 7.6v8.8L12 20.8 3.8 16.4V7.6Z" />
      {/* top face */}
      <path d="M3.8 7.6 12 12l8.2-4.4M12 12v8.8" />
      {/* section plane hint */}
      <path d="M7 7.1v7.6l5 2.6" strokeDasharray="1.6 1.8" strokeWidth={1.2} />
      {/* axis tick marks */}
      <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Fallback card if the page render throws: the rest of the shell keeps working. */
class CadErrorBoundary extends React.Component<
  { title: string; hint: string; retry: string; children: React.ReactNode },
  { failed: boolean; message: string }
> {
  constructor(props: { title: string; hint: string; retry: string; children: React.ReactNode }) {
    super(props)
    this.state = { failed: false, message: '' }
  }

  static getDerivedStateFromError(error: unknown): { failed: boolean; message: string } {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[dsh-plugin-cad] page render failed:', error)
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="dsh-cad-page">
        <div className="dsh-cad-state">
          <div className="dsh-cad-state-card error">
            <strong>{this.props.title}</strong>
            <p>{this.props.hint}</p>
            <p>{this.state.message}</p>
            <div className="dsh-cad-actions">
              <button
                type="button"
                className="dsh-cad-button primary"
                onClick={() => this.setState({ failed: false, message: '' })}
              >
                {this.props.retry}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}

/** Slot component: the page behind the boundary, with the injected translator. */
function CadSlotPage(props: PageProps): React.ReactElement {
  const t = props.t ?? translate
  return (
    <CadErrorBoundary title={t('error')} hint={t('errorHint')} retry={t('refresh')}>
      <CadPage {...props} />
    </CadErrorBoundary>
  )
}

/** Cordis plugin body for the browser half. */
export function apply(ctx: ClientContext): void {
  try {
    activate(ctx)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[dsh-plugin-cad] client activation failed:', error)
    throw error
  }
}

/** Register dictionaries, styles and both slot entries as effects. */
function activate(ctx: ClientContext): void {
  // 1. Locale dictionaries (en + zh) and the translator seen by the page.
  withEffect(ctx, () => {
    if (ctx.locale === undefined || typeof ctx.locale.register !== 'function') {
      warn('locale service unavailable; falling back to the built-in dictionary')
      return () => undefined
    }
    try {
      const disposer = ctx.locale.register(LOCALE_NS, { en: EN, zh: ZH })
      if (typeof ctx.locale.bind === 'function') {
        try {
          setTranslate(ctx.locale.bind(LOCALE_NS))
        } catch (error) {
          warn(`locale bind failed: ${String(error)}`)
        }
      }
      return typeof disposer === 'function' ? disposer : () => undefined
    } catch (error) {
      warn(`locale registration failed: ${String(error)}`)
      return () => undefined
    }
  }, 'dsh-plugin-cad: locale dictionaries')

  // 2. One stylesheet, removed again when the plugin is disabled.
  withEffect(ctx, () => {
    const style = document.createElement('style')
    style.dataset.dshPluginCad = ''
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-plugin-cad: styles')

  // 3. Read-only build marker for diagnostics and the browser E2E.
  withEffect(ctx, () => {
    const globalObject = window as unknown as { __DSH_CAD_CLIENT__?: { build: string } }
    const previous = globalObject.__DSH_CAD_CLIENT__
    globalObject.__DSH_CAD_CLIENT__ = { build: CLIENT_BUILD }
    return () => {
      if (previous === undefined) delete globalObject.__DSH_CAD_CLIENT__
      else globalObject.__DSH_CAD_CLIENT__ = previous
    }
  }, 'dsh-plugin-cad: diagnostics hook')

  // 4. Full-size page in the main panel.
  if (ctx.slots === undefined || typeof ctx.slots.register !== 'function') {
    warn('slots service unavailable; the CAD page was not registered')
    return
  }
  try {
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: LOCALE_NS,
      inject: (): PageProps => ({ t: translate }),
    }, CadSlotPage))
  } catch (error) {
    warn(`main slot registration failed: ${String(error)}`)
  }

  // 5. Sidebar glyph that selects the page.
  try {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 36,
      locale: LOCALE_NS,
      label: () => translate('panel'),
    }, CadIcon))
  } catch (error) {
    warn(`sidebar slot registration failed: ${String(error)}`)
  }
}

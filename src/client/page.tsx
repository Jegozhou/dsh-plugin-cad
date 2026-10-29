/**
 * The in-Harness CAD page: model rail, real three.js viewport, geometry and
 * revision inspector.
 *
 * State ownership:
 *
 *  - the **Host** owns models, revisions and artifacts; this page only keeps
 *    view state (selected model id, camera, selection) and re-reads the Host on
 *    mount, on a short poll while visible and on every revision change, so a
 *    page reload recovers from Host-persisted state alone (`localStorage`
 *    remembers the selected model id, never model data);
 *  - the **viewer** owns WebGL and is disposed on unmount;
 *  - polling stops when the page unmounts or the document is hidden and never
 *    runs while the slot is not visible.
 *
 * Every failure path (API down, model deleted, runtime offline, failed build,
 * GLB 404/malformed, WebGL unavailable) renders a localized state card instead
 * of throwing into the Harness shell.
 *
 * @module client/page
 */

import * as React from 'react'
import {
  ApiError,
  artifactPath,
  artifactUrl,
  health,
  listModels,
  readModel,
} from './api.ts'
import type {
  BoundingBox,
  GeometryReport,
  HealthInfo,
  ModelDetail,
  ModelSummary,
  Revision,
  RevisionError,
  RevisionSummary,
  Vec3,
} from './api.ts'
import { t as translate } from './locale.ts'
import type { Translate } from './locale.ts'
import { CadViewer } from './viewer.ts'
import type { LoadedModelInfo, PartInfo, ViewerFailure } from './viewer.ts'

/** How often the visible panel re-reads the Host detail endpoint. */
const POLL_INTERVAL_MS = 2000

/** localStorage key for the selected model id (never model data). */
const STORAGE_KEY = 'dsh-plugin-cad:selected-model'

/** Props injected by the `main` slot registration. */
export interface PageProps {
  t?: Translate
}

/** A failed revision kept aside while the previous good revision is shown. */
interface FailedRevision {
  revision: Revision
  error: RevisionError | null
}

/** Read the remembered model id (safe in private/incognito contexts). */
function readStoredModelId(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === null || value === '' ? null : value.slice(0, 80)
  } catch {
    return null
  }
}

/** Remember the selected model id; ignore storage failures. */
function storeModelId(modelId: string | null): void {
  try {
    if (modelId === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, modelId)
  } catch {
    // private mode / disabled storage: the Host is still the source of truth.
  }
}

/** Detect the Harness theme without reaching into another plugin's DOM tree. */
function detectTheme(): 'light' | 'dark' {
  const root = document.documentElement
  const attribute = root.getAttribute('data-theme') ?? document.body?.getAttribute('data-theme')
  if (attribute === 'dark' || attribute === 'light') return attribute
  if (root.classList.contains('dark') || document.body?.classList.contains('dark')) return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
}

/** Track the host theme. */
function useHostTheme(): 'light' | 'dark' {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(detectTheme)
  React.useEffect(() => {
    const update = (): void => setTheme(detectTheme())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', update)
    }
  }, [])
  return theme
}

/** Number formatter shared by every readout. */
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** Format one finite number with an optional unit. */
function formatNumber(value: number | null | undefined, unit?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return unit === undefined ? NUMBER.format(value) : `${NUMBER.format(value)} ${unit}`
}

/** Format a bbox as `80 × 60 × 8 mm`. */
function formatBoxSize(box: BoundingBox | null | undefined, tr: Translate): string {
  if (!box) return tr('notAvailable')
  return `${NUMBER.format(box.size[0])} × ${NUMBER.format(box.size[1])} × ${NUMBER.format(box.size[2])} mm`
}

/** Format a plain triple. */
function formatVec(vec: Vec3 | null | undefined, unit = ''): string {
  if (!vec) return '—'
  return `${NUMBER.format(vec[0])}, ${NUMBER.format(vec[1])}, ${NUMBER.format(vec[2])}${unit === '' ? '' : ` ${unit}`}`
}

/** Format an ISO timestamp compactly; invalid values become `—`. */
function formatTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return iso
  }
}

/** Human message for an exception. */
function errorText(error: unknown, tr: Translate): string {
  if (error instanceof ApiError) {
    if (error.code === 'runtime_unavailable' || error.status === 503) return tr('runtimeUnavailable')
    if (error.code === 'not_found' || error.status === 404) return tr('modelMissing')
    return error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Pick the newest model from a listing. The Host's order is documented as
 * newest-first, but the page does not depend on that: it compares timestamps
 * and revision numbers so auto-selection is stable either way.
 */
function sortNewestFirst(models: ModelSummary[]): ModelSummary[] {
  return [...models].sort((a, b) => {
    const timeA = a.updatedAt === null || a.updatedAt === undefined ? 0 : Date.parse(a.updatedAt)
    const timeB = b.updatedAt === null || b.updatedAt === undefined ? 0 : Date.parse(b.updatedAt)
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA
    return (b.latestRevision ?? 0) - (a.latestRevision ?? 0)
  })
}

/** Whether a model has at least one successfully built revision to render. */
function hasBuiltGeometry(model: ModelSummary): boolean {
  if (model.currentRevisionId !== null && model.currentRevisionId !== undefined) return true
  return (model.artifacts ?? []).some(artifact => artifact.format.toLowerCase() === 'glb')
}

/**
 * Pick the model to show when nothing is remembered: the newest one, preferring
 * models that already have built geometry. A model whose latest revision is
 * still unbuilt/failed cannot be rendered, and auto-selecting it would leave
 * the viewer on an empty state even though other models are viewable.
 */
function pickDefaultModel(models: ModelSummary[]): ModelSummary | null {
  if (models.length === 0) return null
  const sorted = sortNewestFirst(models)
  return sorted.find(hasBuiltGeometry) ?? sorted[0] ?? null
}

/** Viewer failure → localized sentence. */
function failureText(failure: ViewerFailure, tr: Translate): string {
  switch (failure.code) {
    case 'not-found': return tr('glbNotFound')
    case 'malformed':
    case 'empty':
    case 'parse': return tr('glbMalformed')
    case 'unavailable': return tr('runtimeUnavailable')
    case 'network':
    case 'http': return failure.message
    case 'webgl':
    case 'context-lost': return failure.message
    default: return failure.message
  }
}

/** Status label for a revision status. */
function statusText(status: string, tr: Translate): string {
  if (status === 'built') return tr('statusReady')
  if (status === 'failed') return tr('statusFailed')
  if (status === 'unbuilt') return tr('statusUnbuilt')
  return status
}

/** Worst status of a checks array, for the badge. */
function worstCheckStatus(report: GeometryReport | null | undefined): 'pass' | 'warn' | 'fail' | null {
  if (!report?.checks || report.checks.length === 0) return null
  if (report.checks.some(check => check.status === 'fail')) return 'fail'
  if (report.checks.some(check => check.status === 'warn')) return 'warn'
  return 'pass'
}

/** Revision badge class. */
function statusClass(status: string): string {
  if (status === 'failed') return 'error'
  if (status === 'built') return 'ok'
  return 'warn'
}

/** The page component registered into the Harness `main` slot. */
export function CadPage({ t: injected }: PageProps = {}): React.ReactElement {
  const tr = injected ?? translate
  const theme = useHostTheme()

  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const viewerRef = React.useRef<CadViewer | null>(null)
  const mountedRef = React.useRef(true)

  const [models, setModels] = React.useState<ModelSummary[]>([])
  const [listPhase, setListPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = React.useState<string | null>(null)

  const [selectedId, setSelectedId] = React.useState<string | null>(readStoredModelId)
  const [selectedRevision, setSelectedRevision] = React.useState<number | null>(null)
  const [detail, setDetail] = React.useState<ModelDetail | null>(null)
  const [history, setHistory] = React.useState<RevisionSummary[]>([])
  const [failedRevision, setFailedRevision] = React.useState<FailedRevision | null>(null)
  const [detailPhase, setDetailPhase] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [detailError, setDetailError] = React.useState<string | null>(null)

  const [healthInfo, setHealthInfo] = React.useState<HealthInfo | null>(null)
  const [healthReachable, setHealthReachable] = React.useState<boolean | null>(null)
  const [runtimeDismissed, setRuntimeDismissed] = React.useState(false)

  const [viewerPhase, setViewerPhase] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [viewerFailure, setViewerFailure] = React.useState<ViewerFailure | null>(null)
  const [sceneInfo, setSceneInfo] = React.useState<LoadedModelInfo | null>(null)
  const [picked, setPicked] = React.useState<PartInfo | null>(null)
  const [viewerEpoch, setViewerEpoch] = React.useState(0)
  const [webglUnavailable, setWebglUnavailable] = React.useState<string | null>(null)

  const [notice, setNotice] = React.useState<string | null>(null)
  const [hasUpdate, setHasUpdate] = React.useState(false)

  const listAbortRef = React.useRef<AbortController | null>(null)
  const detailAbortRef = React.useRef<AbortController | null>(null)
  const detailTokenRef = React.useRef(0)
  const pollBusyRef = React.useRef(false)
  const pollTickRef = React.useRef(0)
  const noticeTimerRef = React.useRef<number | null>(null)
  const selectedIdRef = React.useRef<string | null>(selectedId)
  const selectedRevisionRef = React.useRef<number | null>(selectedRevision)
  const detailRef = React.useRef<ModelDetail | null>(detail)
  const listPhaseRef = React.useRef(listPhase)

  React.useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  React.useEffect(() => { selectedRevisionRef.current = selectedRevision }, [selectedRevision])
  React.useEffect(() => { detailRef.current = detail }, [detail])
  React.useEffect(() => { listPhaseRef.current = listPhase }, [listPhase])

  /** Show a transient notice; a later notice replaces it. */
  const showNotice = React.useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      if (mountedRef.current) setNotice(null)
    }, 4200)
  }, [])

  /** Whether this page is actually on screen (slot may be mounted but hidden). */
  const pageVisible = React.useCallback((): boolean => {
    const element = rootRef.current
    if (element === null) return false
    const withCheck = element as HTMLElement & { checkVisibility?: () => boolean }
    if (typeof withCheck.checkVisibility === 'function') {
      try {
        return withCheck.checkVisibility()
      } catch {
        return element.offsetParent !== null
      }
    }
    return element.offsetParent !== null
  }, [])

  /** Read the model list from the Host and keep the selection valid. */
  const refreshModels = React.useCallback(async (silent = false): Promise<void> => {
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    if (!silent) setListPhase('loading')
    try {
      const list = await listModels(controller.signal)
      if (!mountedRef.current) return
      setModels(list)
      setListError(null)
      setListPhase('ready')
      const current = selectedIdRef.current
      const match = current === null ? undefined : list.find(model => model.id === current)
      if (match === undefined) {
        const next = pickDefaultModel(list)
        const nextId = next === null ? null : next.id
        selectedIdRef.current = nextId
        setSelectedId(nextId)
        setSelectedRevision(null)
        setHasUpdate(false)
        storeModelId(nextId)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (!mountedRef.current) return
      if (!silent) {
        setListPhase('error')
        setListError(errorText(error, tr))
      }
    }
  }, [tr])

  /** Read plugin/runtime health; failures only hide the badge. */
  const refreshHealth = React.useCallback(async (): Promise<void> => {
    try {
      const info = await health()
      if (!mountedRef.current) return
      setHealthInfo(info)
      setHealthReachable(true)
    } catch {
      if (!mountedRef.current) return
      setHealthInfo(null)
      setHealthReachable(false)
    }
  }, [])

  /**
   * Read one model revision. When the requested revision is the implicit
   * "current" one, a newer revision may be in flight or failed; the Host keeps
   * `currentRevision` pointing at the last successful build, so the panel shows
   * that geometry and surfaces the failure separately instead of going blank.
   */
  const loadDetail = React.useCallback(async (
    modelId: string,
    revision: number | null,
    options: { silent?: boolean } = {},
  ): Promise<void> => {
    detailAbortRef.current?.abort()
    const controller = new AbortController()
    detailAbortRef.current = controller
    const token = ++detailTokenRef.current
    if (!options.silent) setDetailPhase('loading')
    try {
      let next = await readModel(modelId, {
        revision: revision === null ? undefined : revision,
        include: 'full',
        signal: controller.signal,
      })
      let failed: FailedRevision | null = next.revision.status === 'failed'
        ? { revision: next.revision, error: next.revision.error ?? null }
        : null

      if (revision === null) {
        const latestNumber = next.model.latestRevision ?? 0
        const currentNumber = next.model.currentRevision ?? 0
        // A newer revision exists that is not the built current one: read it
        // once (read-only) so the page can show why the latest build failed or
        // that it is still unbuilt, while the valid geometry stays on screen.
        if (latestNumber > currentNumber && next.model.latestRevisionId !== null && next.model.latestRevisionId !== undefined) {
          try {
            const latest = await readModel(modelId, {
              revision: next.model.latestRevisionId,
              include: 'summary',
              signal: controller.signal,
            })
            if (latest.revision.status === 'failed') {
              failed = { revision: latest.revision, error: latest.revision.error ?? null }
            }
          } catch {
            // The secondary read is diagnostic only; never fail the page on it.
          }
        }
        if (next.revision.status === 'failed' && currentNumber >= 1) {
          next = await readModel(modelId, { revision: currentNumber, include: 'full', signal: controller.signal })
        }
      }

      if (token !== detailTokenRef.current || !mountedRef.current) return
      setFailedRevision(failed)
      setDetail(next)
      setHistory(next.history)
      setDetailError(null)
      setDetailPhase('ready')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (token !== detailTokenRef.current || !mountedRef.current) return
      setDetailPhase('error')
      setDetailError(errorText(error, tr))
      if (error instanceof ApiError && (error.code === 'not_found' || error.status === 404)) {
        setDetail(null)
        setDetailPhase('error')
      }
    }
  }, [tr])

  /**
   * Poll the Host while the panel is visible. The browser only re-reads; every
   * write stays with the Host/tools. `currentRevisionId` changing means the
   * built geometry moved, so the detail (and then the GLB URL) is re-fetched;
   * a newer but not-yet-built revision only updates the failure/notice state.
   */
  const pollOnce = React.useCallback(async (modelId: string): Promise<void> => {
    if (pollBusyRef.current) return
    pollBusyRef.current = true
    pollTickRef.current += 1
    const tick = pollTickRef.current
    try {
      const revision = selectedRevisionRef.current
      const fresh = await readModel(modelId, {
        revision: revision === null ? undefined : revision,
        include: 'summary',
      })
      if (!mountedRef.current) return
      setHistory(fresh.history)
      const known = detailRef.current
      if (known !== null) {
        const knownCurrent = known.model.currentRevisionId ?? ''
        const current = fresh.model.currentRevisionId ?? ''
        const knownLatest = `${known.model.latestRevision ?? 0}:${known.model.latestRevisionId ?? ''}`
        const latest = `${fresh.model.latestRevision ?? 0}:${fresh.model.latestRevisionId ?? ''}`
        if (current !== knownCurrent) {
          if (revision !== null) {
            // The user pinned an older revision; offer the new one instead of
            // yanking the geometry out from under them.
            setHasUpdate(true)
          } else {
            await loadDetail(modelId, null, { silent: true })
            void refreshModels(true)
            showNotice(tr('newRevisionBody', { value: fresh.model.currentRevisionId ?? current }))
          }
        } else if (latest !== knownLatest && revision === null) {
          // Latest revision changed without a new built artifact yet: refresh
          // the failure/notice state but keep the last good geometry displayed.
          await loadDetail(modelId, null, { silent: true })
        }
      }
      if (tick % 3 === 0) {
        void refreshHealth()
        void refreshModels(true)
      }
    } catch (error) {
      if (!mountedRef.current) return
      if (error instanceof ApiError && (error.code === 'not_found' || error.status === 404)) {
        setDetailPhase('error')
        setDetailError(tr('modelMissing'))
        void refreshModels()
      }
      // Other poll failures stay silent; the health badge and retry button
      // cover them rather than flashing a banner every two seconds.
    } finally {
      pollBusyRef.current = false
    }
  }, [loadDetail, refreshHealth, refreshModels, showNotice, tr])

  // --- mount / unmount ------------------------------------------------------
  React.useEffect(() => {
    mountedRef.current = true
    void refreshModels()
    void refreshHealth()
    return () => {
      mountedRef.current = false
      listAbortRef.current?.abort()
      detailAbortRef.current?.abort()
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [refreshHealth, refreshModels])

  // --- viewer lifecycle (one WebGL context per mounted page) ----------------
  React.useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    let viewer: CadViewer | null = null
    try {
      viewer = new CadViewer(element, {
        onLoading: () => {
          if (!mountedRef.current) return
          setViewerPhase('loading')
        },
        onLoad: info => {
          if (!mountedRef.current) return
          setSceneInfo(info)
          setViewerPhase('ready')
          setViewerFailure(null)
        },
        onError: failure => {
          if (!mountedRef.current) return
          setViewerFailure(failure)
          setViewerPhase('error')
        },
        onPick: part => {
          if (!mountedRef.current) return
          setPicked(part)
        },
      })
      viewerRef.current = viewer
      viewer.setTheme(theme)
      setWebglUnavailable(null)
    } catch (error) {
      setWebglUnavailable(error instanceof Error ? error.message : String(error))
    }
    return () => {
      if (viewer !== null) viewer.dispose()
      viewerRef.current = null
    }
    // Mount once: theme changes are applied by the effect below, not by
    // recreating the WebGL context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    viewerRef.current?.setTheme(theme)
  }, [theme])

  // --- detail loading -------------------------------------------------------
  React.useEffect(() => {
    if (listPhase !== 'ready') return
    if (selectedId === null) {
      setDetail(null)
      setHistory([])
      setFailedRevision(null)
      setDetailPhase('idle')
      return
    }
    void loadDetail(selectedId, selectedRevision)
  }, [listPhase, selectedId, selectedRevision, loadDetail])

  // --- polling --------------------------------------------------------------
  React.useEffect(() => {
    if (selectedId === null) return
    const id = selectedId
    const interval = window.setInterval(() => {
      if (!mountedRef.current) return
      if (document.visibilityState !== 'visible') return
      if (!pageVisible()) return
      void pollOnce(id)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [selectedId, pageVisible, pollOnce])

  // --- GLB loading ----------------------------------------------------------
  const glbUrl = React.useMemo(() => {
    if (detail === null) return null
    const revision = detail.revision
    // Only a built revision has geometry. `viewer.glbUrl` always points at the
    // Host's *current* revision, so the selected revision's own artifact list is
    // preferred when the user pinned an older revision.
    if (revision.status !== 'built') return null
    const own = artifactUrl(revision.artifacts, 'glb')
    if (own !== null) return own
    const direct = detail.viewer.glbUrl
    if (typeof direct === 'string' && direct !== '') {
      if (detail.model.currentRevisionId === revision.revisionId) return direct
      const same = artifactPath(detail.model.id, revision.revisionId, 'model.glb')
      return same
    }
    return artifactPath(detail.model.id, revision.revisionId, 'model.glb')
  }, [detail])

  React.useEffect(() => {
    const viewer = viewerRef.current
    if (viewer === null) return
    if (glbUrl === null) {
      setViewerPhase('idle')
      setSceneInfo(null)
      setViewerFailure(null)
      return
    }
    setViewerFailure(null)
    void viewer.load(glbUrl)
  }, [glbUrl, viewerEpoch])

  // --- keyboard shortcuts ---------------------------------------------------
  React.useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
    }
    const handler = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTyping(event.target)) return
      if (!pageVisible()) return
      const viewer = viewerRef.current
      if (viewer === null) return
      const key = event.key.toLowerCase()
      if (key === 'r') {
        event.preventDefault()
        viewer.resetView()
        setPicked(null)
      } else if (key === 'f') {
        event.preventDefault()
        viewer.fitView()
      } else if (event.key === 'Escape') {
        viewer.clearSelection()
        setPicked(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pageVisible])

  // --- actions --------------------------------------------------------------
  const selectModel = React.useCallback((modelId: string): void => {
    if (modelId === selectedIdRef.current) return
    selectedIdRef.current = modelId
    setSelectedId(modelId)
    setSelectedRevision(null)
    selectedRevisionRef.current = null
    setHasUpdate(false)
    setPicked(null)
    setSceneInfo(null)
    setDetail(null)
    setFailedRevision(null)
    setDetailPhase('loading')
    storeModelId(modelId)
  }, [])

  const selectRevision = React.useCallback((revision: number | null): void => {
    selectedRevisionRef.current = revision
    setSelectedRevision(revision)
    setPicked(null)
    setHasUpdate(false)
  }, [])

  const viewCurrent = React.useCallback((): void => {
    selectRevision(null)
  }, [selectRevision])

  const retryAll = React.useCallback((): void => {
    setRuntimeDismissed(false)
    setViewerFailure(null)
    void refreshModels()
    void refreshHealth()
    if (selectedId !== null) void loadDetail(selectedId, selectedRevision)
    setViewerEpoch(value => value + 1)
  }, [refreshModels, refreshHealth, selectedId, selectedRevision, loadDetail])

  const retryGlb = React.useCallback((): void => {
    setViewerFailure(null)
    setViewerEpoch(value => value + 1)
  }, [])

  // --- derived readouts -----------------------------------------------------
  const report = detail?.revision.report ?? null
  const activeRevision = detail?.revision ?? null
  const watchingCurrent = selectedRevision === null
  const runtimeAvailable = healthInfo?.runtime.available === true
  const runtimeState = healthInfo?.runtime.state ?? null
  // The Python runtime is spawned lazily: `available:false` with state
  // "stopped" and no lastError is the normal idle state, not a fault. Only an
  // explicit error/crash state (or a failed health request) surfaces a banner.
  const runtimeFailed = healthInfo !== null && (
    (healthInfo.runtime.lastError !== null && healthInfo.runtime.lastError !== undefined)
    || runtimeState === 'crashed'
    || runtimeState === 'error'
    || runtimeState === 'failed'
  )
  const showRuntimeBanner = !runtimeDismissed
    && healthReachable !== false
    && healthInfo !== null
    && runtimeFailed
  const latestFailed = watchingCurrent
    && (failedRevision !== null || detail?.model.failing === true)

  /**
   * One stable state value for automation and assistive tech:
   * `empty | loading | ready | error`.
   */
  const viewStatus: 'empty' | 'loading' | 'ready' | 'error' = (() => {
    if (listPhase === 'error') return 'error'
    if (listPhase === 'ready' && models.length === 0) return 'empty'
    if (webglUnavailable !== null) return 'error'
    if (detailPhase === 'error') return 'error'
    if (viewerPhase === 'error') return 'error'
    // "unbuilt" means a build is in flight (Host contract): keep polling and
    // show progress rather than an error.
    if (detail !== null && detail.revision.status === 'unbuilt') return 'loading'
    if (detail !== null && glbUrl === null && failedRevision !== null) return 'error'
    if (detail !== null && glbUrl === null && detail.revision.status !== 'built') return 'error'
    if (viewerPhase === 'ready') return 'ready'
    return 'loading'
  })()

  /** Status line under the viewport. */
  const statusLine = detail === null
    ? tr('panelHint')
    : `${detail.model.name} · ${detail.revision.revisionId} · ${statusText(detail.revision.status, tr)}`

  /** Runtime badge in the header. */
  const runtimeBadge = healthReachable === false
    ? { className: 'dsh-cad-badge error', label: tr('unavailable') }
    : healthInfo === null
      ? { className: 'dsh-cad-badge', label: tr('loading') }
      : runtimeAvailable
        ? { className: 'dsh-cad-badge ok', label: tr('runtimeReady') }
        : runtimeFailed
          ? { className: 'dsh-cad-badge error', label: tr('runtimeUnavailable') }
          : runtimeState === 'starting'
            ? { className: 'dsh-cad-badge warn', label: tr('runtimeStarting') }
            : { className: 'dsh-cad-badge', label: tr('runtimeIdle') }

  /** Overlay card in the viewport, if any. */
  const renderViewerState = (): React.ReactElement | null => {
    if (listPhase === 'error') {
      return (
        <div className="dsh-cad-state" role="alert">
          <div className="dsh-cad-state-card error">
            <strong>{tr('unavailable')}</strong>
            <p>{tr('unavailableHint')}</p>
            <p>{listError}</p>
            <div className="dsh-cad-actions">
              <button type="button" className="dsh-cad-button primary" onClick={retryAll}>{tr('retry')}</button>
            </div>
          </div>
        </div>
      )
    }
    if (listPhase === 'ready' && models.length === 0) {
      return (
        <div className="dsh-cad-state">
          <div className="dsh-cad-state-card">
            <strong>{tr('noModels')}</strong>
            <p>{tr('noModelsHint')}</p>
            <div className="dsh-cad-actions">
              <button type="button" className="dsh-cad-button" onClick={retryAll}>{tr('refresh')}</button>
            </div>
          </div>
        </div>
      )
    }
    if (webglUnavailable !== null) {
      return (
        <div className="dsh-cad-state" role="alert">
          <div className="dsh-cad-state-card error">
            <strong>{tr('glbFailed')}</strong>
            <p>{webglUnavailable}</p>
            <div className="dsh-cad-actions">
              <button type="button" className="dsh-cad-button primary" onClick={retryAll}>{tr('retry')}</button>
            </div>
          </div>
        </div>
      )
    }
    if (detailPhase === 'error' && detail === null) {
      return (
        <div className="dsh-cad-state" role="alert">
          <div className="dsh-cad-state-card error">
            <strong>{tr('error')}</strong>
            <p>{detailError ?? tr('errorHint')}</p>
            <div className="dsh-cad-actions">
              <button type="button" className="dsh-cad-button primary" onClick={retryAll}>{tr('retry')}</button>
            </div>
          </div>
        </div>
      )
    }
    if (detail === null) {
      return (
        <div className="dsh-cad-state">
          <div className="dsh-cad-state-card">
            <strong><span className="dsh-cad-spinner" aria-hidden="true" />{tr('loadingModel')}</strong>
          </div>
        </div>
      )
    }
    if (glbUrl === null) {
      if (detail.revision.status === 'unbuilt') {
        return (
          <div className="dsh-cad-state">
            <div className="dsh-cad-state-card">
              <strong><span className="dsh-cad-spinner" aria-hidden="true" />{tr('buildingInFlight')}</strong>
              <p>{tr('waitingForBuild')}</p>
            </div>
          </div>
        )
      }
      const failed = failedRevision !== null || detail.revision.status === 'failed'
      return (
        <div className="dsh-cad-state">
          <div className={`dsh-cad-state-card ${failed ? 'error' : 'warn'}`}>
            <strong>{failed ? tr('failedBuild') : tr('statusUnbuilt')}</strong>
            {failed && failedRevision !== null && failedRevision.error !== null
              ? <p>{failedRevision.error.code}: {failedRevision.error.message}</p>
              : null}
            <p>{failed ? tr('failedBuildHint') : tr('empty')}</p>
            <div className="dsh-cad-actions">
              <button type="button" className="dsh-cad-button" onClick={retryGlb}>{tr('retry')}</button>
            </div>
          </div>
        </div>
      )
    }
    if (viewerPhase === 'error' && viewerFailure !== null) {
      return (
        <div className="dsh-cad-state" role="alert">
          <div className="dsh-cad-state-card error">
            <strong>{tr('glbFailed')}</strong>
            <p>{failureText(viewerFailure, tr)}</p>
            <div className="dsh-cad-actions">
              <button type="button" className="dsh-cad-button primary" onClick={retryGlb}>{tr('retry')}</button>
            </div>
          </div>
        </div>
      )
    }
    if (viewerPhase === 'loading') {
      return (
        <div className="dsh-cad-state">
          <div className="dsh-cad-state-card">
            <strong><span className="dsh-cad-spinner" aria-hidden="true" />{tr('loadingGlb')}</strong>
          </div>
        </div>
      )
    }
    return null
  }

  /** Geometry / validation body for the rail. */
  const renderGeometry = (): React.ReactElement | null => {
    if (detail === null) return null
    const revision = detail.revision
    const geometry = revision.report
    const bbox = geometry?.bbox ?? null
    const topology = geometry?.topology ?? null
    const checks = geometry?.checks ?? []
    const warnings = geometry?.warnings ?? []
    const parameters = detail.model.parameters ?? null
    const features = geometry?.featureReports ?? []
    const passCount = checks.filter(check => check.status === 'pass').length
    const warnCount = checks.filter(check => check.status === 'warn').length
    const failCount = checks.filter(check => check.status === 'fail').length
    return (
      <section className="dsh-cad-section" aria-label={tr('geometry')}>
        <div className="dsh-cad-section-title">{tr('geometry')}</div>
        <dl className="dsh-cad-dl">
          <dt>{tr('revision')}</dt>
          <dd>{revision.revisionId}</dd>
          <dt>{tr('status')}</dt>
          <dd>{statusText(revision.status, tr)}</dd>
          <dt>{tr('volume')}</dt>
          <dd>{formatNumber(geometry?.volume, 'mm³')}</dd>
          <dt>{tr('surfaceArea')}</dt>
          <dd>{formatNumber(geometry?.surfaceArea, 'mm²')}</dd>
          <dt>{tr('boundingBox')}</dt>
          <dd>{formatBoxSize(bbox, tr)}</dd>
          <dt>{tr('centroid')}</dt>
          <dd>{formatVec(geometry?.centroid, 'mm')}</dd>
          <dt>{tr('solids')}</dt>
          <dd>{formatNumber(topology?.solids)}</dd>
          <dt>{tr('faces')}</dt>
          <dd>{formatNumber(topology?.faces)}</dd>
          <dt>{tr('edges')}</dt>
          <dd>{formatNumber(topology?.edges)}</dd>
          <dt>{tr('vertices')}</dt>
          <dd>{formatNumber(topology?.vertices)}</dd>
          <dt>{tr('triangles')}</dt>
          <dd>{formatNumber(sceneInfo?.triangles)}</dd>
        </dl>
        {checks.length > 0 ? (
          <div className="dsh-cad-checks" aria-label={tr('validation')}>
            <div className="dsh-cad-check">
              <span className="dsh-cad-check-id">{tr('validation')}</span>
              <span>{passCount}/{checks.length} {tr('pass').toLowerCase()} · {warnCount} {tr('warn').toLowerCase()} · {failCount} {tr('fail').toLowerCase()}</span>
            </div>
            {checks.filter(check => check.status !== 'pass').map(check => (
              <div key={check.id} className={`dsh-cad-check ${check.status}`}>
                <span className="dsh-cad-check-id">{check.status}</span>
                <span>{check.id}{check.message ? `: ${check.message}` : ''}</span>
              </div>
            ))}
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <ul className="dsh-cad-warning-list" aria-label={tr('warnings')}>
            {warnings.map(warning => <li key={warning}>{warning}</li>)}
          </ul>
        ) : null}
        {features.length > 0 ? (
          <div className="dsh-cad-checks" aria-label={tr('features')}>
            {features.map(feature => (
              <div key={feature.id} className={`dsh-cad-check ${feature.status === 'pass' ? '' : feature.status}`}>
                <span className="dsh-cad-check-id">{feature.id}</span>
                <span>{feature.op} · {statusText(feature.status, tr)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {parameters !== null && Object.keys(parameters).length > 0 ? (
          <dl className="dsh-cad-dl" aria-label={tr('parameters')} style={{ marginTop: 8 }}>
            {Object.entries(parameters).slice(0, 16).map(([name, value]) => (
              <React.Fragment key={name}>
                <dt>{name}</dt>
                <dd>{formatNumber(value, 'mm')}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : null}
      </section>
    )
  }

  return (
    <div
      className="dsh-cad-page"
      data-cad-theme={theme}
      data-dsh-plugin="dsh-plugin-cad"
      data-model-id={detail?.model.id ?? ''}
      data-revision-id={detail?.revision.revisionId ?? ''}
      ref={rootRef}
    >
      <header className="dsh-cad-head">
        <strong className="dsh-cad-title">{tr('title')}</strong>
        <span className="dsh-cad-sub" data-testid="cad-model-name">{detail !== null ? detail.model.name : tr('panelHint')}</span>
        <span className="dsh-cad-spacer" />
        {detail !== null ? (
          selectedRevision === null ? (
            <span className="dsh-cad-badge current" title={tr('revision')} data-testid="cad-revision">
              {tr('revisionLabel', { value: detail.revision.revisionId })}
            </span>
          ) : (
            <button
              type="button"
              className="dsh-cad-button small"
              onClick={viewCurrent}
              title={tr('current')}
              data-testid="cad-revision"
              aria-label={`${tr('viewingRevision', { value: detail.revision.revisionId })} — ${tr('current')}`}
            >
              {tr('viewingRevision', { value: detail.revision.revisionId })} · {tr('current')}
            </button>
          )
        ) : null}
        {detail !== null && (report?.warnings?.length ?? 0) > 0 ? (
          <span className="dsh-cad-badge warn" title={tr('warnings')}>{report?.warnings?.length} {tr('warnings')}</span>
        ) : null}
        {latestFailed ? <span className="dsh-cad-badge error">{tr('failedBuild')}</span> : null}
        <span className={runtimeBadge.className} title={`${runtimeBadge.label}${healthInfo?.runtime.lastError ? ` — ${healthInfo.runtime.lastError}` : ''}`}>
          <span className="dsh-cad-dot" aria-hidden="true" />{runtimeBadge.label}
        </span>
        <button
          type="button"
          className="dsh-cad-button"
          onClick={() => { viewerRef.current?.fitView() }}
          disabled={viewerPhase !== 'ready'}
          aria-label={tr('fitView')}
          data-testid="cad-fit"
          title={`${tr('fitView')} (F)`}
        >
          {tr('fitView')}
        </button>
        <button
          type="button"
          className="dsh-cad-button"
          onClick={() => { viewerRef.current?.resetView(); viewerRef.current?.clearSelection(); setPicked(null) }}
          disabled={viewerPhase !== 'ready'}
          aria-label={tr('resetView')}
          data-testid="cad-reset"
          title={`${tr('resetView')} (R)`}
        >
          {tr('resetView')}
        </button>
        <button
          type="button"
          className="dsh-cad-button"
          onClick={retryAll}
          aria-label={tr('refresh')}
          data-testid="cad-refresh"
          title={tr('refresh')}
        >
          {tr('refresh')}
        </button>
      </header>

      <div className="dsh-cad-body">
        <aside className="dsh-cad-side" aria-label={tr('models')}>
          <section className="dsh-cad-section" aria-label={tr('models')}>
            <div className="dsh-cad-section-title">
              {tr('models')}
              <span className="dsh-cad-count">{models.length > 0 ? `(${models.length})` : ''}</span>
            </div>
            <div className="dsh-cad-list" role="listbox" aria-label={tr('models')} data-testid="cad-model-list">
              {listPhase === 'loading' ? (
                <div className="dsh-cad-loading"><span className="dsh-cad-spinner" aria-hidden="true" />{tr('loadingModels')}</div>
              ) : null}
              {listPhase === 'error' ? (
                <div className="dsh-cad-loading">
                  <p>{listError ?? tr('unavailable')}</p>
                  <button type="button" className="dsh-cad-button small" onClick={retryAll}>{tr('retry')}</button>
                </div>
              ) : null}
              {listPhase === 'ready' && models.length === 0 ? (
                <div className="dsh-cad-loading">
                  <p>{tr('noModels')}</p>
                  <p className="dsh-cad-muted">{tr('noModelsHint')}</p>
                </div>
              ) : null}
              {models.map(model => {
                const selected = model.id === selectedId
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-current={selected ? 'true' : undefined}
                    className="dsh-cad-item"
                    data-model-id={model.id}
                    onClick={() => selectModel(model.id)}
                    title={`${model.name} · ${model.id}`}
                  >
                    <span className="dsh-cad-item-name">{model.name}</span>
                    <span className="dsh-cad-item-meta">
                      <span>{model.currentRevisionId ?? model.latestRevisionId ?? '—'}</span>
                      {model.failing ? (
                        <span className="dsh-cad-item-error">{tr('statusFailed')}</span>
                      ) : model.latestStatus === 'unbuilt' && (model.currentRevision ?? 0) === 0 ? (
                        <span className="dsh-cad-item-warn">{tr('statusUnbuilt')}</span>
                      ) : null}
                      {model.updatedAt ? <span>{formatTime(model.updatedAt)}</span> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          {renderGeometry()}

          {history.length > 0 ? (
            <section className="dsh-cad-section" aria-label={tr('history')}>
              <div className="dsh-cad-section-title">{tr('history')}</div>
              <div className="dsh-cad-history" role="list">
                {history.map(entry => {
                  const active = detail !== null
                    ? entry.revisionId === detail.revision.revisionId
                    : entry.number === selectedRevision
                  return (
                    <button
                      key={entry.revisionId}
                      type="button"
                      role="listitem"
                      className="dsh-cad-history-row"
                      aria-current={active ? 'true' : undefined}
                      aria-label={`${tr('viewRevision')} ${entry.revisionId}`}
                      onClick={() => selectRevision(detail !== null && entry.number === detail.model.currentRevision ? null : entry.number)}
                    >
                      <span className="dsh-cad-rev">{entry.revisionId}</span>
                      <span className={`dsh-cad-rev-status ${entry.status}`}>{statusText(entry.status, tr)}</span>
                      {entry.reportSummary?.volume !== null && entry.reportSummary?.volume !== undefined ? (
                        <span>{formatNumber(entry.reportSummary.volume)} mm³</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </section>
          ) : detail !== null ? (
            <section className="dsh-cad-section">
              <div className="dsh-cad-section-title">{tr('history')}</div>
              <div className="dsh-cad-loading">{tr('historyEmpty')}</div>
            </section>
          ) : null}
        </aside>

        <main className="dsh-cad-main">
          <div
            className="dsh-cad-viewport"
            ref={containerRef}
            tabIndex={0}
            role="application"
            aria-label={tr('viewerAria')}
          >
            {renderViewerState()}

            {viewerPhase === 'ready' && sceneInfo !== null ? (
              <div className="dsh-cad-overlay top-left">
                <div className="dsh-cad-chips">
                  <span className="dsh-cad-chip">
                    <span className="dsh-cad-chip-label">{tr('triangles')}</span>
                    <span className="dsh-cad-chip-value">{formatNumber(sceneInfo.triangles)}</span>
                  </span>
                  <span className="dsh-cad-chip">
                    <span className="dsh-cad-chip-label">{tr('boundingBox')}</span>
                    <span className="dsh-cad-chip-value">{formatBoxSize(sceneInfo.bbox, tr)}</span>
                  </span>
                  <span className="dsh-cad-chip">
                    <span className="dsh-cad-chip-value">{detail?.model.units ?? 'mm'}</span>
                  </span>
                </div>
              </div>
            ) : null}

            {picked !== null ? (
              <div className="dsh-cad-inspect" role="region" aria-label={tr('pickedPart')}>
                <div className="dsh-cad-inspect-head">
                  <strong title={picked.name}>{picked.name}</strong>
                  <span className="dsh-cad-spacer" />
                  <button
                    type="button"
                    className="dsh-cad-button small ghost"
                    onClick={() => { viewerRef.current?.clearSelection(); setPicked(null) }}
                    aria-label={tr('clearSelection')}
                  >
                    ×
                  </button>
                </div>
                <dl className="dsh-cad-dl">
                  <dt>{tr('partName')}</dt>
                  <dd>{picked.meshName === '' ? picked.name : picked.meshName}</dd>
                  <dt>{tr('partMaterial')}</dt>
                  <dd>{picked.materialName}</dd>
                  <dt>{tr('triangles')}</dt>
                  <dd>{formatNumber(picked.triangles)}</dd>
                  <dt>{tr('vertices')}</dt>
                  <dd>{formatNumber(picked.vertices)}</dd>
                  <dt>{tr('boundingBox')}</dt>
                  <dd>{formatBoxSize(picked.bbox, tr)}</dd>
                  <dt>{tr('centroid')}</dt>
                  <dd>{formatVec(picked.center, 'mm')}</dd>
                </dl>
              </div>
            ) : null}

            {hasUpdate ? (
              <div className="dsh-cad-banner" role="status">
                <strong>{tr('newRevision')}</strong>
                <p>{tr('newRevisionBody', { value: detail?.model.latestRevisionId ?? '' })}</p>
                <div className="dsh-cad-actions">
                  <button type="button" className="dsh-cad-button small" onClick={() => setHasUpdate(false)}>{tr('dismiss')}</button>
                  <button type="button" className="dsh-cad-button small primary" onClick={viewCurrent}>{tr('current')}</button>
                </div>
              </div>
            ) : null}

            {latestFailed && !hasUpdate ? (
              <div className="dsh-cad-banner error" role="alert">
                <strong>{tr('failedBuild')}</strong>
                <p>
                  {failedRevision?.error !== null && failedRevision?.error !== undefined
                    ? `${failedRevision.error.code}: ${failedRevision.error.message}`
                    : tr('failedBuildHint')}
                </p>
                <div className="dsh-cad-actions">
                  {failedRevision !== null ? (
                    <button
                      type="button"
                      className="dsh-cad-button small"
                      onClick={() => selectRevision(failedRevision.revision.number)}
                    >
                      {tr('revisionLabel', { value: failedRevision.revision.revisionId })}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {showRuntimeBanner ? (
              <div className="dsh-cad-banner" role="status">
                <strong>{tr('runtimeUnavailable')}</strong>
                <p>{tr('runtimeUnavailableHint')}</p>
                <div className="dsh-cad-actions">
                  <button type="button" className="dsh-cad-button small" onClick={() => setRuntimeDismissed(true)}>{tr('dismiss')}</button>
                  <button type="button" className="dsh-cad-button small" onClick={retryAll}>{tr('retry')}</button>
                </div>
              </div>
            ) : null}

            {notice !== null ? (
              <div className="dsh-cad-toast" role="status">{notice}</div>
            ) : null}

            <div className="dsh-cad-overlay bottom">
              <div className="dsh-cad-hint">
                <kbd>R</kbd> {tr('resetView')} · <kbd>F</kbd> {tr('fitView')} · <kbd>Esc</kbd> {tr('clearSelection')}
              </div>
            </div>
          </div>

          <span className="dsh-cad-testhook" data-testid="cad-status" aria-hidden="true">{viewStatus}</span>
          <footer className="dsh-cad-status" role="status" aria-live="polite">
            <span>{statusLine}</span>
            {detail !== null && detail.revision.builtAt ? <span>· {tr('updatedAt', { value: formatTime(detail.revision.builtAt) })}</span> : null}
            <span className="dsh-cad-spacer" />
            {detailError !== null && detail !== null ? <span className="dsh-cad-error-text">{detailError}</span> : null}
            {healthReachable === false ? <span className="dsh-cad-error-text">{tr('unavailable')}</span> : null}
            {picked === null && viewerPhase === 'ready' ? <span>{tr('pickedNone')}</span> : null}
            <code>{detail?.model.id ?? ''}</code>
          </footer>
        </main>
      </div>
    </div>
  )
}

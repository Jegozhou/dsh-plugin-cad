/**
 * Imperative three.js CAD viewer.
 *
 * The React page owns the DOM shell; this class owns WebGL and every resource
 * that must die with it. It is deliberately framework-free so the page can
 * support slot re-renders and unmounts without leaking a GPU context, a RAF
 * loop, an observer or an event listener:
 *
 *  - one `WebGLRenderer` bound to one `<canvas>` inside the container;
 *  - one `requestAnimationFrame` loop, paused while the document is hidden;
 *  - `ResizeObserver` + pointer listeners installed in the constructor and
 *    removed in {@link CadViewer.dispose};
 *  - geometries, materials, edge segments, grid, axes, label textures, the
 *    PMREM environment render target and the renderer itself are disposed.
 *
 * Geometry comes only from the Host: this class is given a same-origin GLB URL
 * and never fetches anything else. A failed download, a 404/503 or a malformed
 * container becomes an `onError` callback with a code the page can localize —
 * never an exception that escapes into the Harness shell.
 *
 * @module client/viewer
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { fetchGlb, GlbError } from './api.ts'
import type { BoundingBox, Vec3 } from './api.ts'

/** Lighting/selection palette in the style of a mechanical CAD workbench. */
const CAD_MATERIAL_COLOR = 0xb9c4d2
const CAD_MATERIAL_DARK = 0x9fadc0
const LIGHT_EDGE = 0x2a3442
const DARK_EDGE = 0xb9c6d6

/** One picked part, in the units the Host reports (millimetres). */
export interface PartInfo {
  /** Display name derived from the glTF node chain (`Part` when unnamed). */
  name: string
  /** Raw mesh name from the GLB (may be empty). */
  meshName: string
  /** `parent/child` node chain, for debugging. */
  path: string
  triangles: number
  vertices: number
  materialName: string
  /** Bounding box of the part in model coordinates (mm). */
  bbox: BoundingBox
  center: Vec3
}

/** Stats of the loaded scene. */
export interface LoadedModelInfo {
  meshes: number
  triangles: number
  vertices: number
  bbox: BoundingBox
}

/** A viewer failure with a stable code the page can localize. */
export interface ViewerFailure {
  code: 'http' | 'not-found' | 'unavailable' | 'malformed' | 'network' | 'empty' | 'parse' | 'webgl' | 'context-lost'
  message: string
  status: number
}

/** Callbacks invoked by the viewer; the page re-renders from them. */
export interface ViewerCallbacks {
  onLoading?: () => void
  onLoad?: (info: LoadedModelInfo) => void
  onError?: (failure: ViewerFailure) => void
  onPick?: (part: PartInfo | null) => void
}

/** Theme the viewer should paint in. */
export type ViewerTheme = 'light' | 'dark'

/** Clamp a number to a range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Round a size up to a 1/2/5×10^n step, used for the ground grid. */
function niceStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const fraction = value / base
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return step * base
}

/** Whether a colour is effectively white (the glTF default material). */
function isNearWhite(color: THREE.Color): boolean {
  return color.r > 0.82 && color.g > 0.82 && color.b > 0.82
}

/** Dispose a material's own textures plus the material itself. */
function disposeMaterial(material: THREE.Material, textures: Set<THREE.Texture>): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value)
  }
  material.dispose()
}

/** Dispose every geometry/material/texture below a root object. */
function disposeObject3D(root: THREE.Object3D, textures: Set<THREE.Texture> = new Set()): void {
  root.traverse(object => {
    const geometry = (object as THREE.Mesh).geometry
    if (geometry !== undefined && geometry !== null) geometry.dispose()
    const material = (object as THREE.Mesh).material
    if (material === undefined || material === null) return
    if (Array.isArray(material)) {
      for (const entry of material) disposeMaterial(entry, textures)
    } else {
      disposeMaterial(material, textures)
    }
  })
  for (const texture of textures) texture.dispose()
  textures.clear()
}

/** Build a text sprite (used for X/Y/Z axis labels); caller disposes it. */
function makeAxisLabel(text: string, color: string, size: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')
  if (context !== null) {
    context.clearRect(0, 0, 64, 64)
    context.font = 'bold 42px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = color
    context.fillText(text, 32, 34)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.setScalar(size)
  sprite.renderOrder = 20
  return sprite
}

/**
 * Owns one WebGL canvas showing one revisioned GLB.
 *
 * Usage: `const viewer = new CadViewer(container, callbacks)`, then
 * `await viewer.load(url)` whenever the Host publishes a revision, and
 * `viewer.dispose()` when the React page unmounts.
 */
export class CadViewer {
  private readonly container: HTMLElement
  private readonly callbacks: ViewerCallbacks
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly loader: GLTFLoader
  private readonly resizeObserver: ResizeObserver | null

  private readonly meshes: THREE.Mesh[] = []
  private readonly edgeMaterials: THREE.LineBasicMaterial[] = []
  private readonly labelSprites: THREE.Sprite[] = []
  private readonly abortControllers = new Set<AbortController>()
  private readonly textures = new Set<THREE.Texture>()

  private modelRoot: THREE.Object3D | null = null
  private modelBounds: THREE.Box3 = new THREE.Box3()
  private grid: THREE.GridHelper | null = null
  private axes: THREE.Group | null = null
  private selectionBox: THREE.BoxHelper | null = null
  private selectedMesh: THREE.Mesh | null = null
  private selectedEmissive: Array<{ material: THREE.Material; hex: number; intensity: number }> = []

  private environmentTarget: THREE.WebGLRenderTarget | null = null
  private environmentScene: RoomEnvironment | null = null

  private raf = 0
  private disposed = false
  private loadToken = 0
  private homePosition = new THREE.Vector3(1, 0.85, 1)
  private homeTarget = new THREE.Vector3(0, 0, 0)
  private theme: ViewerTheme = 'light'
  private accent = '#4b8bff'
  private pointerStart: { x: number; y: number; button: number } | null = null
  private readonly pointerDownHandler: (event: PointerEvent) => void
  private readonly pointerUpHandler: (event: PointerEvent) => void
  private readonly pointerCancelHandler: () => void
  private readonly contextLostHandler: (event: Event) => void
  private readonly visibilityHandler: () => void
  private readonly controlsStartHandler: () => void
  private readonly controlsEndHandler: () => void

  constructor(container: HTMLElement, callbacks: ViewerCallbacks = {}) {
    this.container = container
    this.callbacks = callbacks
    this.accent = this.readAccent()

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1e7)
    this.camera.position.set(120, 90, 120)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch (error) {
      throw new ViewerCreationError(error instanceof Error ? error.message : 'WebGL is unavailable')
    }
    this.renderer = renderer
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(320, 240, false)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.domElement.className = 'dsh-cad-canvas'
    this.renderer.domElement.dataset.testid = 'cad-canvas'
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    this.container.append(this.renderer.domElement)

    this.installLighting()
    this.installEnvironment()

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.085
    this.controls.rotateSpeed = 0.85
    this.controls.zoomSpeed = 0.9
    this.controls.panSpeed = 0.85
    this.controls.screenSpacePanning = true
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

    this.loader = new GLTFLoader()

    this.pointerDownHandler = (event: PointerEvent): void => {
      if (event.button !== 0) return
      this.pointerStart = { x: event.clientX, y: event.clientY, button: event.button }
    }
    this.pointerUpHandler = (event: PointerEvent): void => {
      const start = this.pointerStart
      this.pointerStart = null
      if (start === null || start.button !== 0) return
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y)
      if (distance > 5) return
      this.pick(event)
    }
    this.pointerCancelHandler = (): void => { this.pointerStart = null }
    this.contextLostHandler = (event: Event): void => {
      event.preventDefault()
      this.callbacks.onError?.({ code: 'context-lost', message: 'the WebGL context was lost', status: 0 })
    }
    this.visibilityHandler = (): void => {
      if (this.disposed) return
      if (document.hidden) this.stopLoop()
      else this.startLoop()
    }
    this.controlsStartHandler = (): void => this.container.classList.add('is-dragging')
    this.controlsEndHandler = (): void => this.container.classList.remove('is-dragging')

    const element = this.renderer.domElement
    element.addEventListener('pointerdown', this.pointerDownHandler)
    element.addEventListener('pointerup', this.pointerUpHandler)
    element.addEventListener('pointercancel', this.pointerCancelHandler)
    element.addEventListener('webglcontextlost', this.contextLostHandler as EventListener)
    this.controls.addEventListener('start', this.controlsStartHandler)
    this.controls.addEventListener('end', this.controlsEndHandler)
    document.addEventListener('visibilitychange', this.visibilityHandler)

    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.resize())
      : null
    this.resizeObserver?.observe(container)

    this.resize()
    this.startLoop()
  }

  /** Apply a theme to the chrome the viewer owns (grid/edges). */
  setTheme(theme: ViewerTheme): void {
    if (this.disposed) return
    this.theme = theme
    this.applyThemeColors()
  }

  /** Update the selection accent (read from the Host CSS variables by the page). */
  setAccent(color: string): void {
    if (this.disposed || color.trim() === '') return
    this.accent = color.trim()
    if (this.selectionBox !== null && this.selectedMesh !== null) {
      this.clearSelection()
      this.select(this.selectedMesh)
    }
  }

  /** Load (or reload) one GLB revision. Superseded loads are disposed. */
  async load(url: string): Promise<void> {
    if (this.disposed) return
    const token = ++this.loadToken
    this.callbacks.onLoading?.()
    const controller = new AbortController()
    this.abortControllers.add(controller)
    try {
      const buffer = await fetchGlb(url, controller.signal)
      if (token !== this.loadToken || this.disposed) return
      const gltf: GLTF = await this.loader.parseAsync(buffer, '')
      if (token !== this.loadToken || this.disposed) {
        const textures = new Set<THREE.Texture>()
        disposeObject3D(gltf.scene, textures)
        return
      }
      this.applyModel(gltf.scene)
    } catch (error) {
      if (token !== this.loadToken || this.disposed) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      this.callbacks.onError?.(toViewerFailure(error))
    } finally {
      this.abortControllers.delete(controller)
    }
  }

  /** Restore the initial iso view (R). */
  resetView(): void {
    if (this.disposed) return
    this.camera.position.copy(this.homePosition)
    this.controls.target.copy(this.homeTarget)
    this.controls.update()
  }

  /** Frame the current model (F). */
  fitView(): void {
    if (this.disposed) return
    this.frameModel(true)
  }

  /** Drop the current selection and its highlight (Esc). */
  clearSelection(): void {
    if (this.selectedMesh !== null) {
      for (const entry of this.selectedEmissive) {
        const material = entry.material as THREE.MeshStandardMaterial
        if (material.emissive !== undefined) material.emissive.setHex(entry.hex)
        if (typeof material.emissiveIntensity === 'number') material.emissiveIntensity = entry.intensity
      }
      this.selectedMesh = null
    }
    this.selectedEmissive = []
    if (this.selectionBox !== null) {
      this.scene.remove(this.selectionBox)
      this.selectionBox.geometry.dispose()
      this.selectionBox.material.dispose()
      this.selectionBox = null
    }
  }

  /** Dispose every resource and detach every listener. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loadToken += 1
    for (const controller of this.abortControllers) controller.abort()
    this.abortControllers.clear()
    this.stopLoop()

    const element = this.renderer.domElement
    element.removeEventListener('pointerdown', this.pointerDownHandler)
    element.removeEventListener('pointerup', this.pointerUpHandler)
    element.removeEventListener('pointercancel', this.pointerCancelHandler)
    element.removeEventListener('webglcontextlost', this.contextLostHandler as EventListener)
    this.controls.removeEventListener('start', this.controlsStartHandler)
    this.controls.removeEventListener('end', this.controlsEndHandler)
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    this.resizeObserver?.disconnect()

    this.clearSelection()
    this.disposeModel()
    this.disposeHelpers()

    if (this.environmentTarget !== null) {
      this.scene.environment = null
      this.environmentTarget.dispose()
      this.environmentTarget = null
    }
    if (this.environmentScene !== null) {
      this.environmentScene.dispose()
      this.environmentScene = null
    }

    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    element.remove()
    this.container.classList.remove('is-dragging')
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Read the selection accent from the page's CSS variables. */
  private readAccent(): string {
    try {
      const style = getComputedStyle(this.container)
      const value = style.getPropertyValue('--cad-accent').trim()
      return value === '' ? '#4b8bff' : value
    } catch {
      return '#4b8bff'
    }
  }

  /** Static studio-style lighting; no shadows so the viewer stays cheap. */
  private installLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2b3542, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 2.1)
    key.position.set(1.1, 1.6, 1.2)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xcddcff, 0.8)
    fill.position.set(-1.4, 0.7, -0.9)
    this.scene.add(fill)
    const rim = new THREE.DirectionalLight(0xffffff, 0.65)
    rim.position.set(0.2, -0.9, -1.3)
    this.scene.add(rim)
  }

  /**
   * Image-based lighting from three's RoomEnvironment. It gives the CAD steel
   * material real reflections instead of flat shading. Failure is non-fatal: a
   * machine without PMREM support still gets the analytic lights above.
   */
  private installEnvironment(): void {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer)
      const room = new RoomEnvironment()
      this.environmentTarget = pmrem.fromScene(room, 0.04)
      this.scene.environment = this.environmentTarget.texture
      this.scene.environmentIntensity = 0.9
      this.environmentScene = room
      pmrem.dispose()
    } catch {
      this.environmentScene = null
    }
  }

  /** Apply theme-dependent colours to grid and edges. */
  private applyThemeColors(): void {
    const dark = this.theme === 'dark'
    const edgeColor = dark ? DARK_EDGE : LIGHT_EDGE
    for (const material of this.edgeMaterials) {
      material.color.setHex(edgeColor)
      material.opacity = dark ? 0.34 : 0.42
    }
    if (this.grid !== null) {
      const center = this.grid.material as THREE.LineBasicMaterial
      center.color.setHex(dark ? 0x5b6b7d : 0x9aa7b6)
      center.opacity = dark ? 0.5 : 0.6
      const gridMaterial = this.grid.material as THREE.Material
      gridMaterial.needsUpdate = true
    }
  }

  /** Device-pixel-correct resize; a zero-sized slot is tolerated. */
  private resize(): void {
    if (this.disposed) return
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width <= 0 || height <= 0) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.render(this.scene, this.camera)
  }

  /** Start the render loop (idempotent). */
  private startLoop(): void {
    if (this.raf !== 0 || this.disposed) return
    const tick = (): void => {
      this.raf = requestAnimationFrame(tick)
      if (this.disposed) return
      if (this.container.clientWidth <= 0 || this.container.clientHeight <= 0) return
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** Stop the render loop (idempotent). */
  private stopLoop(): void {
    if (this.raf === 0) return
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** Replace the displayed model root. */
  private applyModel(root: THREE.Object3D): void {
    this.clearSelection()
    this.disposeModel()

    this.modelRoot = root
    this.scene.add(root)
    root.updateMatrixWorld(true)

    const materials: THREE.Material[] = []
    const originals = new Set<THREE.Material>()
    let triangles = 0
    let vertices = 0

    root.traverse(object => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh !== true || mesh.geometry === undefined) return
      this.meshes.push(mesh)

      const geometry = mesh.geometry
      const position = geometry.getAttribute('position')
      const vertexCount = position === undefined ? 0 : position.count
      const index = geometry.getIndex()
      triangles += index !== null ? Math.floor(index.count / 3) : Math.floor(vertexCount / 3)
      vertices += vertexCount

      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const clones = source.map(entry => {
        originals.add(entry)
        const clone = entry.clone()
        this.configureMaterial(clone)
        materials.push(clone)
        return clone
      })
      mesh.material = Array.isArray(mesh.material) ? clones : clones[0]
      // Edges make the tessellated B-rep read as a CAD part instead of a blob.
      if (vertexCount > 0 && vertexCount < 300_000) {
        try {
          const edgeGeometry = new THREE.EdgesGeometry(geometry, 26)
          const edgeMaterial = new THREE.LineBasicMaterial({
            color: this.theme === 'dark' ? DARK_EDGE : LIGHT_EDGE,
            transparent: true,
            opacity: 0.42,
            depthWrite: false,
          })
          const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial)
          lines.name = 'dsh-cad-edges'
          lines.renderOrder = 2
          mesh.add(lines)
          this.edgeMaterials.push(edgeMaterial)
        } catch {
          // Edge extraction is cosmetic; a failure must not hide the part.
        }
      }
    })
    // The originals are never rendered again; disposing them keeps the GPU
    // allocation flat across revision reloads. Their textures are shared with
    // the clones, so only the material objects are released here.
    for (const original of originals) original.dispose()

    this.modelBounds = new THREE.Box3().setFromObject(root)
    if (this.modelBounds.isEmpty()) this.modelBounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))

    this.installHelpers()
    this.frameModel(true)
    this.applyThemeColors()

    this.callbacks.onLoad?.({
      meshes: this.meshes.length,
      triangles,
      vertices,
      bbox: boxToBoundingBox(this.modelBounds),
    })
    this.callbacks.onPick?.(null)
  }

  /** Give one material the CAD look without destroying authored colours. */
  private configureMaterial(material: THREE.Material): void {
    const standard = material as THREE.MeshStandardMaterial
    if (standard.color === undefined) return
    standard.polygonOffset = true
    standard.polygonOffsetFactor = 1
    standard.polygonOffsetUnits = 1
    if (standard.envMapIntensity !== undefined) standard.envMapIntensity = 1
    const authored = (standard.name !== undefined && standard.name !== '') || !isNearWhite(standard.color)
    if (authored) {
      // Respect a colour that came from the model, but keep the PBR response in
      // a range that reads well under studio lighting.
      standard.metalness = clamp(standard.metalness ?? 0.1, 0.05, 0.5)
      standard.roughness = clamp(standard.roughness ?? 0.5, 0.3, 0.75)
      return
    }
    standard.color.setHex(this.theme === 'dark' ? CAD_MATERIAL_DARK : CAD_MATERIAL_COLOR)
    standard.metalness = 0.3
    standard.roughness = 0.42
  }

  /** Rebuild grid, axes and axis labels for the current model bounds. */
  private installHelpers(): void {
    this.disposeHelpers()

    const box = this.modelBounds
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const span = Math.max(size.x, size.z, 1)

    // Ground grid sized to the part, sitting at the model's lowest point.
    const gridSize = niceStep(span * 1.5)
    const divisions = clamp(Math.round(gridSize / niceStep(gridSize / 10)), 4, 40)
    const grid = new THREE.GridHelper(gridSize, divisions, 0x9aa7b6, 0x76828f)
    const gridMaterial = grid.material as THREE.LineBasicMaterial
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.35
    gridMaterial.depthWrite = false
    grid.position.set(center.x, box.min.y, center.z)
    grid.name = 'dsh-cad-grid'
    this.scene.add(grid)
    this.grid = grid

    const axisLength = Math.max(span * 0.48, 10)
    const axes = new THREE.Group()
    axes.name = 'dsh-cad-axes'
    const helper = new THREE.AxesHelper(axisLength)
    const helperMaterial = helper.material as THREE.LineBasicMaterial
    helperMaterial.transparent = true
    helperMaterial.opacity = 0.95
    helperMaterial.depthTest = false
    helper.renderOrder = 10
    axes.add(helper)

    const labelSize = axisLength * 0.19
    const labels: Array<{ text: string; color: string; direction: THREE.Vector3 }> = [
      { text: 'X', color: '#e05a5a', direction: new THREE.Vector3(1, 0, 0) },
      { text: 'Y', color: '#57a75c', direction: new THREE.Vector3(0, 1, 0) },
      { text: 'Z', color: '#5a86e0', direction: new THREE.Vector3(0, 0, 1) },
    ]
    for (const label of labels) {
      const sprite = makeAxisLabel(label.text, label.color, labelSize)
      sprite.position.copy(label.direction).multiplyScalar(axisLength * 1.12)
      axes.add(sprite)
      this.labelSprites.push(sprite)
    }
    this.scene.add(axes)
    this.axes = axes
  }

  /** Dispose grid/axes/labels. */
  private disposeHelpers(): void {
    if (this.grid !== null) {
      this.scene.remove(this.grid)
      const material = this.grid.material as THREE.Material
      material.dispose()
      this.grid.geometry.dispose()
      this.grid = null
    }
    if (this.axes !== null) {
      this.scene.remove(this.axes)
      disposeObject3D(this.axes, this.textures)
      this.axes = null
    }
    this.labelSprites.length = 0
  }

  /** Dispose the current model root and everything it owns. */
  private disposeModel(): void {
    this.meshes.length = 0
    this.edgeMaterials.length = 0
    if (this.modelRoot !== null) {
      this.scene.remove(this.modelRoot)
      disposeObject3D(this.modelRoot, this.textures)
      this.modelRoot = null
    }
    this.modelBounds = new THREE.Box3()
  }

  /** Frame the model with an isometric view; optionally store it as home. */
  private frameModel(storeHome: boolean): void {
    const box = this.modelBounds
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.length() / 2, 0.001)
    const fov = (this.camera.fov * Math.PI) / 180
    const distance = (radius / Math.sin(fov / 2)) * 1.12
    const direction = new THREE.Vector3(1, 0.82, 1).normalize()

    this.homePosition.copy(center).addScaledVector(direction, distance)
    this.homeTarget.copy(center)
    this.camera.position.copy(this.homePosition)
    this.controls.target.copy(this.homeTarget)
    this.camera.near = Math.max(radius / 5000, 0.01)
    this.camera.far = Math.max(radius * 5000, 1000)
    this.camera.updateProjectionMatrix()
    this.controls.minDistance = radius * 0.08
    this.controls.maxDistance = radius * 40
    this.controls.update()
  }

  /** Raycast the click point against the loaded meshes. */
  private pick(event: PointerEvent): void {
    if (this.meshes.length === 0) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(pointer, this.camera)
    const hits = raycaster.intersectObjects(this.meshes, false)
    const hit = hits[0]
    if (hit === undefined) {
      this.clearSelection()
      this.callbacks.onPick?.(null)
      return
    }
    this.select(hit.object as THREE.Mesh)
    this.callbacks.onPick?.(this.describeMesh(hit.object as THREE.Mesh, hit.faceIndex ?? null))
  }

  /** Apply the selection highlight. */
  private select(mesh: THREE.Mesh): void {
    this.clearSelection()
    this.selectedMesh = mesh
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const accentColor = new THREE.Color(this.accent)
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial
      if (standard.emissive === undefined) continue
      this.selectedEmissive.push({
        material,
        hex: standard.emissive.getHex(),
        intensity: typeof standard.emissiveIntensity === 'number' ? standard.emissiveIntensity : 1,
      })
      standard.emissive.copy(accentColor)
      standard.emissiveIntensity = 0.42
    }
    const box = new THREE.BoxHelper(mesh, this.accent)
    const material = box.material as THREE.LineBasicMaterial
    material.depthTest = false
    material.transparent = true
    material.opacity = 0.95
    box.renderOrder = 15
    this.scene.add(box)
    this.selectionBox = box
  }

  /** Describe one mesh for the info panel. */
  private describeMesh(mesh: THREE.Mesh, faceIndex: number | null): PartInfo {
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    const vertexCount = position === undefined ? 0 : position.count
    const index = geometry.getIndex()
    const triangles = index !== null ? Math.floor(index.count / 3) : Math.floor(vertexCount / 3)
    const bounds = new THREE.Box3().setFromObject(mesh)
    const center = bounds.getCenter(new THREE.Vector3())
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const materialName = materialNameOf(materials[0], faceIndex, geometry)
    const chain = nodeChain(mesh)
    return {
      name: chain === '' ? 'Part' : chain,
      meshName: mesh.name,
      path: chain,
      triangles,
      vertices: vertexCount,
      materialName,
      bbox: boxToBoundingBox(bounds),
      center: [center.x, center.y, center.z],
    }
  }
}

/** Thrown when a WebGL context cannot be created at all. */
export class ViewerCreationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ViewerCreationError'
  }
}

/** Convert a three Box3 into the Host's flat bbox shape. */
function boxToBoundingBox(box: THREE.Box3): BoundingBox {
  const min = box.min
  const max = box.max
  return {
    min: [min.x, min.y, min.z],
    max: [max.x, max.y, max.z],
    size: [max.x - min.x, max.y - min.y, max.z - min.z],
  }
}

/** Best-effort material name for the info panel. */
function materialNameOf(material: THREE.Material | undefined, faceIndex: number | null, geometry: THREE.BufferGeometry): string {
  if (material === undefined) return '—'
  const name = material.name
  if (name !== undefined && name !== '') return name
  // Multi-material meshes carry material groups; report the group's material.
  if (faceIndex !== null && Array.isArray(geometry.groups)) {
    const group = geometry.groups.find(entry => faceIndex >= entry.start && faceIndex < entry.start + entry.count)
    if (group !== undefined) return `material-${group.materialIndex ?? 0}`
  }
  return 'default'
}

/** Build a readable node path (`Rig/Part/plate`). */
function nodeChain(mesh: THREE.Mesh): string {
  const parts: string[] = []
  let node: THREE.Object3D | null = mesh
  while (node !== null && node.name !== '' && node.name !== 'dsh-cad-edges') {
    parts.unshift(node.name)
    node = node.parent
  }
  return parts.join('/')
}

/** Map a fetch error into the page-facing failure vocabulary. */
function toViewerFailure(error: unknown): ViewerFailure {
  if (error instanceof GlbError) {
    return { code: error.code, message: error.message, status: error.status }
  }
  if (error instanceof Error) {
    return { code: 'parse', message: error.message, status: 0 }
  }
  return { code: 'parse', message: String(error), status: 0 }
}

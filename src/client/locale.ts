/**
 * Browser-half locale dictionary.
 *
 * `locale/en.json` and `locale/zh.json` carry the Plugin Manager display
 * metadata (title/description) that the Host reads from disk. The strings the
 * page itself renders live here, because the browser bundle cannot fetch
 * package files: the Host's `/plugins` route only serves the built bundle.
 *
 * Both dictionaries expose exactly the same keys; `EN` is the key contract and
 * `ZH` is typed as `Record<keyof typeof EN, string>` so a missing translation is
 * a compile error.
 *
 * @module client/locale
 */

/** Locale namespace registered through `ctx.locale.register`. */
export const LOCALE_NS = 'dsh-plugin-cad'

/** English dictionary (canonical key set). */
export const EN = {
  panel: 'CAD',
  panelHint: 'Parametric CAD models',
  title: 'CAD viewer',
  viewerAria: 'Interactive 3D CAD viewer',

  // Model list / shell chrome.
  models: 'Models',
  loadingModels: 'Loading models…',
  noModels: 'No CAD models yet.',
  noModelsHint: 'Ask the agent to run cad_create_model to build a part.',
  selectModel: 'Select a model',
  modelsCount: '{count} models',
  refresh: 'Refresh',
  retry: 'Retry',

  // Detail / geometry summary.
  loadingModel: 'Loading the model…',
  loadingGlb: 'Loading 3D geometry…',
  buildingInFlight: 'A build is in progress…',
  waitingForBuild: 'The viewer keeps polling the Host; the 3D model appears as soon as the build finishes.',
  geometry: 'Geometry',
  volume: 'Volume',
  surfaceArea: 'Surface area',
  boundingBox: 'Bounding box',
  centroid: 'Centroid',
  solids: 'Solids',
  faces: 'Faces',
  edges: 'Edges',
  vertices: 'Vertices',
  triangles: 'Triangles',
  validation: 'Validation',
  warnings: 'Warnings',
  noWarnings: 'No validation warnings.',
  features: 'Features',
  parameters: 'Parameters',
  loading: 'Loading…',
  status: 'Status',
  statusReady: 'Ready',
  statusFailed: 'Failed',
  statusBuilding: 'Building',
  statusUnbuilt: 'Not built',
  pass: 'Pass',
  fail: 'Fail',
  warn: 'Warn',
  notAvailable: '—',
  updatedAt: 'Updated {value}',
  revision: 'Revision',
  revisionLabel: 'Revision {value}',

  // Revision history.
  history: 'Revision history',
  historyEmpty: 'No revision recorded yet.',
  current: 'Current',
  viewRevision: 'View this revision',
  viewingRevision: 'Viewing {value}',

  // Viewer controls.
  resetView: 'Reset view',
  fitView: 'Fit to model',
  viewerHint: 'Drag to orbit · right-drag to pan · wheel to zoom · R reset · F fit · Esc clear',
  loadingScene: 'Loading the 3D scene…',

  // Selection.
  pickedPart: 'Selected part',
  pickedNone: 'Nothing selected. Click a part to inspect it.',
  partName: 'Name',
  partMaterial: 'Material',
  partTriangles: '{count} triangles',
  clearSelection: 'Clear selection',
  close: 'Close',

  // Errors / states.
  empty: 'No CAD models yet.',
  error: 'Something went wrong',
  errorHint: 'The viewer keeps retrying; use Retry to force a refresh.',
  unavailable: 'Unavailable',
  unavailableHint: 'The Host did not answer the viewer API, so nothing is invented here.',
  runtimeUnavailable: 'The Python CAD runtime is not available.',
  runtimeUnavailableHint:
    'Models that were already built can still be viewed. Ask the agent to run cad_runtime_status to repair the runtime.',
  runtimeReady: 'Runtime ready',
  runtimeIdle: 'Runtime idle (starts on first build)',
  runtimeStarting: 'Runtime starting…',
  modelMissing: 'This model no longer exists.',
  failedBuild: 'The latest build failed.',
  failedBuildHint: 'Showing the last successful revision instead.',
  glbFailed: 'The 3D model could not be loaded.',
  glbNotFound: 'The model artifact is missing (404).',
  glbMalformed: 'The model artifact is not a valid GLB file.',
  httpError: 'Request failed ({status})',
  unknownError: 'Unknown error',

  // Fresh revision notice.
  newRevision: 'New revision available',
  newRevisionBody: 'The Host published {value}; the viewer reloaded it.',
  dismiss: 'Dismiss',

  // Shortcuts help.
  shortcuts: 'Shortcuts',
} as const

/** Chinese dictionary, key-for-key with {@link EN}. */
export const ZH: Record<keyof typeof EN, string> = {
  panel: 'CAD',
  panelHint: '参数化 CAD 模型',
  title: 'CAD 查看器',
  viewerAria: '交互式 3D CAD 查看器',

  models: '模型',
  loadingModels: '正在读取模型…',
  noModels: '还没有 CAD 模型。',
  noModelsHint: '请让 Agent 运行 cad_create_model 创建零件。',
  selectModel: '选择模型',
  modelsCount: '{count} 个模型',
  refresh: '刷新',
  retry: '重试',

  loadingModel: '正在读取模型…',
  loadingGlb: '正在加载三维几何…',
  buildingInFlight: '正在构建…',
  waitingForBuild: '查看器会持续轮询 Host，构建完成后立即显示三维模型。',
  geometry: '几何',
  volume: '体积',
  surfaceArea: '表面积',
  boundingBox: '包围盒',
  centroid: '质心',
  solids: '实体',
  faces: '面',
  edges: '边',
  vertices: '顶点',
  triangles: '三角形',
  validation: '校验',
  warnings: '警告',
  noWarnings: '没有校验警告。',
  features: '特征',
  parameters: '参数',
  loading: '加载中…',
  status: '状态',
  statusReady: '就绪',
  statusFailed: '失败',
  statusBuilding: '构建中',
  statusUnbuilt: '未构建',
  pass: '通过',
  fail: '失败',
  warn: '警告',
  notAvailable: '—',
  updatedAt: '更新于 {value}',
  revision: '修订',
  revisionLabel: '修订 {value}',

  history: '修订历史',
  historyEmpty: '还没有修订记录。',
  current: '当前',
  viewRevision: '查看此修订',
  viewingRevision: '正在查看 {value}',

  resetView: '重置视角',
  fitView: '适应模型',
  viewerHint: '拖动旋转 · 右键拖动平移 · 滚轮缩放 · R 重置 · F 适应 · Esc 取消选择',
  loadingScene: '正在加载三维场景…',

  pickedPart: '选中零件',
  pickedNone: '未选中。点击零件查看信息。',
  partName: '名称',
  partMaterial: '材质',
  partTriangles: '{count} 个三角形',
  clearSelection: '取消选择',
  close: '关闭',

  empty: '还没有 CAD 模型。',
  error: '出错了',
  errorHint: '查看器会继续重试；可点“重试”强制刷新。',
  unavailable: '不可用',
  unavailableHint: 'Host 未响应查看器 API，因此这里不会编造数据。',
  runtimeUnavailable: 'Python CAD 运行时不可用。',
  runtimeUnavailableHint: '已构建的模型仍可查看。请让 Agent 运行 cad_runtime_status 修复运行时。',
  runtimeReady: '运行时就绪',
  runtimeIdle: '运行时空闲（首次构建时启动）',
  runtimeStarting: '运行时启动中…',
  modelMissing: '该模型已不存在。',
  failedBuild: '最近一次构建失败。',
  failedBuildHint: '改为显示上一个成功修订。',
  glbFailed: '三维模型加载失败。',
  glbNotFound: '模型构件缺失（404）。',
  glbMalformed: '模型构件不是有效的 GLB 文件。',
  httpError: '请求失败（{status}）',
  unknownError: '未知错误',

  newRevision: '有新的修订',
  newRevisionBody: 'Host 发布了 {value}，查看器已重新加载。',
  dismiss: '知道了',

  shortcuts: '快捷键',
}

/** A translation key. */
export type MessageKey = keyof typeof EN

/** Interpolation values for `{name}` placeholders. */
export type TranslateParams = Record<string, string | number>

/** Translate one key; unknown keys fall back to the key itself. */
export type Translate = (key: MessageKey, params?: TranslateParams) => string

/** Interpolate `{name}` placeholders without pulling in a formatter library. */
function interpolate(text: string, params?: TranslateParams): string {
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** Pick a base language from the host document, defaulting to English. */
export function detectLanguage(): 'en' | 'zh' {
  const lang = document.documentElement.lang || navigator.language || 'en'
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** Dictionary-backed translator used before/without the locale service. */
function localTranslator(language: 'en' | 'zh'): Translate {
  const dictionary = language === 'zh' ? ZH : EN
  return (key, params) => interpolate(dictionary[key] ?? EN[key] ?? key, params)
}

/**
 * Active translator. `index.tsx` replaces this with `ctx.locale.bind(...)` so
 * language switching and the Plugin Manager's language choice are honoured; if
 * the locale service is unavailable the page stays functional in one language
 * instead of crashing.
 */
let active: Translate = localTranslator(detectLanguage())

/** Replace the active translator; returns the previous one. */
export function setTranslate(next: Translate): Translate {
  const previous = active
  active = next
  return previous
}

/** The current translator. */
export const t: Translate = (key, params) => active(key, params)

/* ============================================================
 * 砌体排砖三维展示 · 查看页共用逻辑 viewer.js  (v3)
 * 页面只需提供：
 *   <div id="app"></div>
 *   window.VIEWER_CONFIG = { manifest: 'model.json', footer: { rvt: 'xxx.rvt' } }
 *   以及指向 ../lib/ 的 importmap
 *
 * model.json 契约（v3 扩展）：
 *   id/title/subtitle/generated/unit/up/source/bbox
 *   floors[]     { key,label,elev,height,file,counts,name }
 *   categories[] { code,label,color }
 *   thicknessGroups[] { code,thickness,label,color,count }   // QC 按墙厚分色
 *   labels       { file,textHeight,defaultOn,lodDistance,nodes:{F01:'L_F01',...} }
 *   stats        { blocks,elements,floors,byCategory }
 * ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from '../lib/OrbitControls.js';
import { GLTFLoader } from '../lib/GLTFLoader.js';
import { DRACOLoader } from '../lib/DRACOLoader.js';

const CFG = window.VIEWER_CONFIG || {};
/* ---------- 版本号：用于绕开 CDN/浏览器缓存，实现"改完刷新即最新" ---------- */
const VERSION_URL = 'version.txt';
let ASSET_VER = 'dev';
async function loadAssetVersion() {
  try {
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      const txt = (await r.text()).trim();
      if (txt) ASSET_VER = txt;
    }
  } catch (e) { /* 离线或不存在时忽略 */ }
}
function withVer(url) {
  if (!ASSET_VER || ASSET_VER === 'dev') return url;
  try {
    const u = new URL(url, location.href);
    u.searchParams.set('v', ASSET_VER);
    return u.href;
  } catch (e) { return url; }
}
/** 页面重新获得焦点 / 每 2 分钟检查一次版本，有新版本自动刷新 */
function watchAssetVersion() {
  let cur = ASSET_VER;
  const check = async () => {
    try {
      const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = (await r.text()).trim();
      if (v && v !== cur) {
        cur = v;
        try { toast('检测到新版本，正在刷新…', 2500); } catch (e) {}
        setTimeout(() => location.reload(), 1000);
      }
    } catch (e) { /* ignore */ }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(check, 120000);
}

const MANIFEST_URL = CFG.manifest || 'model.json';
const MANIFEST_ABS = new URL(MANIFEST_URL, location.href);
const BASE_URL = new URL('./', MANIFEST_ABS);

const APP_TEMPLATE = `
  <canvas id="gl"></canvas>
  <header class="topbar">
    <a class="back" href="../index.html" title="返回入口">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15 18l-6-6 6-6"/></svg>
      返回入口
    </a>
    <div class="titles">
      <h1 id="pageTitle">砌体排砖 · 三维展示</h1>
      <p id="pageSubtitle"></p>
    </div>
    <div class="top-actions">
      <button class="top-btn" id="btnResetTop" type="button">复位视角</button>
    </div>
  </header>
  <div class="statsbar" id="statsbar">
    <div class="statchip"><span class="chip-k"><span class="k-full">总砌块数</span><span class="k-short">砌块</span></span><span class="chip-v brick" id="statTotalBlocks">—</span></div>
    <div class="statchip"><span class="chip-k"><span class="k-full">当前可见楼层</span><span class="k-short">楼层</span></span><span class="chip-v" id="statFloors">—</span></div>
    <div class="statchip"><span class="chip-k"><span class="k-full">当前可见构件</span><span class="k-short">构件</span></span><span class="chip-v" id="statElements">—</span></div>
    <span class="chip-warn" id="chipWarn"></span>
  </div>
  <aside class="panel" id="panel">
    <div class="sheet-handle" id="sheetHandle" role="button" tabindex="0" aria-label="展开或收起控制面板">
      <span class="sheet-grip"></span>
      <span class="sheet-title">楼层 / 类别 / 剖切</span>
      <span class="sheet-chevron">
        <span class="sheet-chevron-text"></span>
        <span class="sheet-chevron-arrow">⌃</span>
      </span>
    </div>
    <div class="panel-scroll">
      <section class="sec">
        <h2 class="sec-h">楼层 <span class="sec-hint">单选 · 再点取消</span></h2>
        <div class="floor-list" id="floorList"></div>
      </section>
      <section class="sec">
        <h2 class="sec-h">类别 <span class="sec-hint">全部楼层联动</span></h2>
        <div class="cat-list" id="catList"></div>
      </section>
      <section class="sec">
        <h2 class="sec-h">剖切 <span class="sec-hint">沿竖向 Y 轴</span></h2>
        <div class="clip-row">
          <div>
            <span class="clip-num is-off" id="clipValue">关闭</span><span class="clip-state" id="clipState"></span>
          </div>
          <button class="btn btn-sm" id="btnClipOff" type="button">关闭剖切</button>
        </div>
        <input class="slider" id="clipRange" type="range" min="0" max="1" step="0.001" value="1" aria-label="剖切高度">
        <div class="clip-scale"><span id="clipMin">—</span><span id="clipMax">—</span></div>
      </section>
      <section class="sec">
        <h2 class="sec-h">工具 <span class="sec-hint">视角 / 显示</span></h2>
        <div class="btn-row">
          <button class="btn" id="btnReset" type="button">复位视角</button>
          <button class="btn" id="btnShowAll" type="button">显示全部</button>
          <button class="btn" id="btnGrid" type="button" aria-pressed="false">地面网格</button>
          <button class="btn" id="btnLabels" type="button" aria-pressed="true">砌块标注</button>
          <button class="btn" id="btnEdges" type="button" aria-pressed="true">砖边线/灰缝</button>
        </div>
      </section>
      <section class="sec">
        <h2 class="sec-h">模型信息 <span class="sec-hint">model.json</span></h2>
        <dl class="info-list" id="infoList"></dl>
      </section>
      <section class="sec">
        <h2 class="sec-h">操作提示 <span class="sec-hint">鼠标 / 触屏</span></h2>
        <ul class="hint-list">
          <li>单击构件可查看族名 / 规格 / 尺寸 / 元素 ID</li>
          <li>左键旋转 · 滚轮 / 双指缩放 · 右键平移</li>
          <li>双击模型或点「复位视角」回到初始视角</li>
          <li>剖切沿竖向 Y 轴，仅作用于模型</li>
        </ul>
      </section>
      <div class="meta-inline" id="metaInline"></div>
    </div>
  </aside>
  <aside class="info-card" id="infoCard" hidden>
    <div class="ic-head">
      <span class="ic-title">构件信息</span>
      <button class="ic-close" id="icClose" type="button" aria-label="关闭构件信息">×</button>
    </div>
    <dl class="ic-list" id="icList"></dl>
    <div class="ic-actions">
      <button class="btn btn-sm" id="icCopy" type="button">复制信息</button>
      <button class="btn btn-sm btn-danger" id="icHide" type="button" title="从模型中永久隐藏该构件（仅本地版）">隐藏此构件</button>
      <span class="ic-hint">点空白处 / Esc 取消</span>
    </div>
  </aside>
  <button class="fab-near" id="btnNear" type="button" title="拉近到墙面，看砖上标注">看标注</button>
  <footer class="meta-footer" id="metaFooter"></footer>
  <div class="toast" id="toast"></div>
  <div class="loader" id="loader">
    <div class="loader-card">
      <div class="loader-brand">江峡三路集镇迁建区（二期一标段）· 砌体排砖</div>
      <h2>正在加载三维模型<small id="loaderProject"></small></h2>
      <div class="loader-track"><div class="loader-bar" id="loaderBar"></div></div>
      <div class="loader-row"><span id="loaderPct">0%</span><span id="loaderStatus">准备中…</span></div>
      <button class="loader-retry" id="loaderRetry" type="button">重新加载</button>
    </div>
  </div>
`;

/* ---------------- 工具函数 ---------------- */
const $ = (id) => document.getElementById(id);
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const fmt = (n) => num(n).toLocaleString('zh-CN');
const fmt2 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—');
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  manifest: null,
  floors: [],
  categories: [],
  thicknessGroups: [],
  catVisible: {},
  thicknessVisible: {},
  selectedFloor: 'all',
  showGrid: false,
  clipEnabled: false,
  clipY: null,
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  model: null,
  ground: null,
  grid: null,
  floorGroups: [],
  materialsByCode: new Map(),
  clipPlane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6),
  bbox: new THREE.Box3(),
  bboxRaw: null,
  worldShift: { x: 0, z: 0 },
  labels: {
    cfg: null,
    root: null,
    nodesByFloor: {},
    loaded: false,
    loading: false,
    deferred: false,
    error: null,
    on: true,
    near: true,
    filter: null,
    invalid: false,
    bounds: null,
    family: '',
  },
  edges: {
    cfg: null,
    root: null,
    nodesByFloor: {},
    loaded: false,
    error: null,
    on: true,
  },
  elements: {
    meta: null,
    rows: null,
    count: 0,
    ready: false,
    error: null,
    cell: 2,
    grid: new Map(),
    floorRows: new Map(),
    floorKeyToIdx: new Map(),
  },
  selection: null,
  pickables: [],
  pick: {
    downX: 0,
    downY: 0,
    downTime: 0,
    dragging: false,
  },
  highlight: null,
  meshCount: 0,
  loadedNodes: 0,
  triangles: 0,
  errors: [],
  loadMs: 0,
  loadStart: 0,
  ready: false,
  userMoved: false,
  sheetTouched: false,
};

const ui = {};

/* ============================================================
 * 一、初始化
 * ============================================================ */
function buildDOM() {
  const app = $('app');
  if (!app) throw new Error('缺少 #app 容器');
  app.innerHTML = APP_TEMPLATE;
  [
    'gl', 'pageTitle', 'pageSubtitle', 'statsbar', 'chipWarn',
    'statTotalBlocks', 'statFloors', 'statElements',
    'panel', 'sheetHandle', 'floorList', 'catList',
    'clipValue', 'clipState', 'clipRange', 'clipMin', 'clipMax',
    'btnClipOff', 'btnReset', 'btnResetTop', 'btnShowAll', 'btnGrid', 'btnLabels', 'btnEdges', 'btnNear',
    'infoCard', 'icList', 'icClose', 'icCopy', 'icHide',
    'infoList', 'metaInline', 'metaFooter', 'toast', 'loader', 'loaderBar', 'loaderPct',
    'loaderStatus', 'loaderProject', 'loaderRetry',
  ].forEach((id) => { ui[id] = $(id); });
  ui.clipRange.style.setProperty('--p', '100%');
}

function makeBackground() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#f7f9fc');
  grad.addColorStop(0.52, '#e9eff6');
  grad.addColorStop(1, '#cfd9e6');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function initThree() {
  const renderer = new THREE.WebGLRenderer({
    canvas: ui.gl, antialias: true, alpha: false, powerPreference: 'high-performance',
  });
  // 移动端限制像素比，保证大模型（十几万面）拖动仍流畅
  const compact = window.innerWidth < 768;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, compact ? 1.6 : 2));
  renderer.localClippingEnabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0xe9eff6, 1);
  state.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = makeBackground();
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
  camera.position.set(20, 18, 22);
  state.camera = camera;

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb6bfca, 1.35);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff7ec, 2.15);
  key.position.set(42, 78, 34);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xdde8f5, 0.85);
  fill.position.set(-46, 32, -38);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.35);
  rim.position.set(-10, 18, 60);
  scene.add(rim);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.85;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = false;
  controls.minPolarAngle = 0.02;
  controls.maxPolarAngle = Math.PI / 2 - 0.012;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN,
  };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.addEventListener('start', () => { state.userMoved = true; });
  state.controls = controls;

  const model = new THREE.Group();
  model.name = 'masonry-model';
  scene.add(model);
  state.model = model;

  renderer.domElement.addEventListener('dblclick', () => resetView());
  window.addEventListener('resize', onResize);
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  if (state.controls) state.controls.update();
  updateLabelsLOD();
  if (state.renderer) state.renderer.render(state.scene, state.camera);
}

/* ============================================================
 * 二、取景 / 视口（避开顶栏、面板、页脚）
 * ============================================================ */
function layoutMetrics() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const mobile = W < 768;
  return {
    W, H, mobile,
    top: mobile ? 82 : 92,
    bottom: mobile ? 64 : 30,
    left: mobile ? 0 : 312,
    margin: mobile ? 10 : 18,
  };
}

function applyViewport() {
  const m = layoutMetrics();
  state.camera.aspect = m.W / m.H;
  // 让模型落在面板右侧、顶栏下方的可用区域内
  state.camera.setViewOffset(m.W, m.H, -m.left / 2, (m.bottom - m.top) / 2, m.W, m.H);
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(m.W, m.H, false);
}

function frameModel(box, save = true) {
  const m = layoutMetrics();
  const availW = Math.max(160, m.W - m.left - 2 * m.margin);
  const availH = Math.max(160, m.H - m.top - m.bottom - 2 * m.margin);
  const center = box.getCenter(new THREE.Vector3());
  const dir = new THREE.Vector3(-0.5, 0.72, 0.5).normalize(); // 西南 45° 俯视

  const tanV = Math.tan(THREE.MathUtils.degToRad(state.camera.fov) / 2);
  const tanH = tanV * (availW / availH);
  const worldUp = new THREE.Vector3(0, 1, 0);
  const forward = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(worldUp, forward);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(forward, right).normalize();

  // 用 8 个包围盒角点做精确取景（比外接球更贴合长条形/多栋分散的模型）
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(0.5, sphere.radius);
  let dist = 0;
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i += 1) {
    p.set(
      (i & 1) ? box.max.x : box.min.x,
      (i & 2) ? box.max.y : box.min.y,
      (i & 4) ? box.max.z : box.min.z,
    ).sub(center);
    const z = p.dot(dir);               // 朝相机方向的分量
    const x = Math.abs(p.dot(right));
    const y = Math.abs(p.dot(up));
    dist = Math.max(dist, z + x / tanH, z + y / tanV);
  }
  dist = Math.max(dist * 1.035, radius * 0.6, 0.5);

  state.camera.position.copy(center).addScaledVector(dir, dist);
  state.controls.target.copy(center);
  state.camera.near = Math.max(0.05, dist * 0.006);
  state.camera.far = Math.max(dist * 12, radius * 12);
  state.camera.updateProjectionMatrix();
  state.controls.minDistance = Math.max(0.2, radius * 0.005); // 允许贴近看砌块标注
  state.controls.maxDistance = dist * 5;
  state.controls.update();
  if (save) state.controls.saveState();
}

function resetView() {
  if (!state.controls) return;
  state.controls.reset();
  state.userMoved = false;
}

function onResize() {
  if (ui.panel && !state.sheetTouched) {
    if (window.innerWidth < 768) ui.panel.classList.add('is-collapsed');
    else ui.panel.classList.remove('is-collapsed');
    applyViewport();
  } else {
    applyViewport();
  }
  if (!state.ready || state.userMoved) return;
  frameModel(state.bbox, true);
}

/* ============================================================
 * 三、数据 / 加载
 * ============================================================ */
async function fetchManifest() {
  const res = await fetch(withVer(MANIFEST_ABS.href), { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function applyManifest() {
  const m = state.manifest;
  document.title = (m.title || '砌体排砖') + ' · 三维展示';
  ui.pageTitle.textContent = m.title || '砌体排砖 · 三维展示';
  ui.pageSubtitle.textContent = m.subtitle || '';
  ui.loaderProject.textContent = m.title ? '· ' + m.title : '';

  state.floors = (Array.isArray(m.floors) ? m.floors : []).map((f) => ({
    key: String(f.key),
    label: f.label || String(f.key),
    name: f.name || '',
    elev: Number(f.elev) || 0,
    height: (f.height == null || !Number.isFinite(Number(f.height))) ? null : Number(f.height),
    file: f.file,
    counts: f.counts && typeof f.counts === 'object' ? f.counts : null,
  }));
  state.categories = (Array.isArray(m.categories) ? m.categories : []).map((c) => ({
    code: String(c.code),
    label: c.label || String(c.code),
    color: c.color || '#b9c0c8',
  }));
  state.thicknessGroups = (Array.isArray(m.thicknessGroups) ? m.thicknessGroups : []).map((g) => ({
    code: String(g.code),
    thickness: Number(g.thickness) || null,
    label: g.label || ('墙厚 ' + (g.thickness || g.code)),
    color: g.color || '#c9b28a',
    count: num(g.count),
  }));
  state.catVisible = {};
  state.categories.forEach((c) => { state.catVisible[c.code] = true; });
  state.thicknessVisible = {};
  state.thicknessGroups.forEach((g) => { state.thicknessVisible[g.code] = true; });

  // ---- 单层固定 / 不显示楼层选择 / 默认关闭某些类别（页面级配置） ----
  state.fixedFloor = '';
  if (CFG.fixedFloor) {
    const want = String(CFG.fixedFloor).toUpperCase();
    const hit = state.floors.find((f) => String(f.key).toUpperCase() === want ||
      String(f.label || '').indexOf(CFG.fixedFloor) >= 0);
    if (hit) { state.selectedFloor = hit.key; state.fixedFloor = hit.key; }
  }
  state.hideFloorPanel = !!(CFG.hideFloorPanel || state.fixedFloor);
  if (Array.isArray(CFG.categoriesOff)) {
    CFG.categoriesOff.forEach((code) => { if (code) state.catVisible[String(code)] = false; });
  }

  const lcfg = m.labels && typeof m.labels === 'object' ? m.labels : null;
  state.labels.cfg = lcfg && lcfg.file ? lcfg : null;
  state.labels.family = (lcfg && lcfg.family) || '';
  // 默认开启砌块标注（含手机端：首次会多下载约 1.3MB 标注文件，换来打开即可见）
  state.labels.on = !(lcfg && lcfg.defaultOn === false);
  state.labels.deferred = false;

  // 砖边线 / 灰缝层（独立 GLB，按楼层同步显隐，不做距离 LOD）
  const ecfg = m.edges && typeof m.edges === 'object' ? m.edges : null;
  state.edges.cfg = ecfg && ecfg.file ? ecfg : null;
  state.edges.on = !(ecfg && ecfg.defaultOn === false);

  // 构件点选数据（与 model.json 同级，缺省 elements.json；加载失败静默降级）
  const elems = m.elements && typeof m.elements === 'object' ? m.elements : null;
  state.elements.cfg = { file: (elems && elems.file) || 'elements.json' };

  const rvt = (m.source && m.source.rvt) || (CFG.footer && CFG.footer.rvt) || '—';
  renderFooter(rvt, m.generated || '—');
}

function renderFooter(rvt, generated) {
  const main = '数据来源 <b>' + esc(rvt) + '</b><span class="meta-sep">·</span>' +
    '导出日期 <b>' + esc(generated) + '</b><span class="meta-sep">·</span>本页离线可运行';
  ui.metaFooter.innerHTML = main + '<span class="meta-right" id="metaRight">three.js r160</span>';
  ui.metaInline.innerHTML = main;
  ui.metaRight = $('metaRight');
}

/** 带字节进度的 fetch，返回 ArrayBuffer */
async function fetchBuffer(url, onProgress) {
  const res = await fetch(withVer(url), { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + decodeURIComponent(url.split('/').pop()));
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    loaded += r.value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

function setProgress(frac, statusText) {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  ui.loaderBar.style.width = pct + '%';
  ui.loaderPct.textContent = pct + '%';
  if (statusText) {
    const sec = state.loadStart ? ((performance.now() - state.loadStart) / 1000).toFixed(1) : '0.0';
    ui.loaderStatus.textContent = statusText + ' · ' + sec + ' s';
  }
}

async function loadAssets() {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(new URL('../lib/draco/', location.href).href);
  draco.setDecoderConfig({ type: 'wasm' });
  loader.setDRACOLoader(draco);

  const floors = state.floors;
  const labelCfg = state.labels.cfg;
  const hasLabels = !!(labelCfg && labelCfg.file) && !state.labels.deferred;
  const edgeCfg = state.edges.cfg;
  const hasEdges = !!(edgeCfg && edgeCfg.file);
  const elemsCfg = state.elements.cfg;
  const hasElements = !!(elemsCfg && elemsCfg.file);
  const totalTasks = floors.length + (hasLabels ? 1 : 0) + (hasEdges ? 1 : 0) + (hasElements ? 1 : 0);
  const fracs = new Array(totalTasks).fill(0);
  const loadedBytes = new Array(totalTasks).fill(0);
  const totalBytes = new Array(totalTasks).fill(0);
  let done = 0;

  const tick = () => {
    // 用“各任务字节进度之和 / 任务数”作为总进度，最多到 98%，最后 2% 留给解析合并，
    // 避免下载完成就提前显示 100%。
    const sum = fracs.reduce((a, b) => a + b, 0);
    const p = totalTasks ? Math.min(0.98, sum / totalTasks) : 0;
    const bytes = loadedBytes.reduce((a, b) => a + b, 0);
    const known = totalBytes.reduce((a, b) => a + b, 0);
    const allKnown = totalBytes.every((t) => t > 0);
    let status;
    if (done >= totalTasks) status = '已接收全部文件，正在解析合并几何…';
    else if (bytes > 0 && allKnown) {
      status = '已接收 ' + (bytes / 1048576).toFixed(1) + ' / ' +
        (known / 1048576).toFixed(1) + ' MB · 完成 ' + done + ' / ' + totalTasks + ' 项';
    } else if (bytes > 0) {
      status = '已接收 ' + (bytes / 1048576).toFixed(1) + ' MB · 完成 ' + done + ' / ' + totalTasks + ' 项';
    } else {
      status = '正在加载 ' + Math.min(done + 1, totalTasks) + ' / ' + totalTasks + ' 项';
    }
    setProgress(p, status);
  };
  tick();

  const report = (i) => (loaded, total) => {
    loadedBytes[i] = loaded;
    totalBytes[i] = total;
    fracs[i] = total ? Math.min(1, loaded / total) : 0;
    tick();
  };

  const floorTasks = floors.map(async (floor, i) => {
    const url = new URL(floor.file, BASE_URL).href;
    try {
      const buf = await fetchBuffer(url, report(i));
      fracs[i] = 1;
      const gltf = await loader.parseAsync(buf, BASE_URL.href);
      done += 1;
      tick();
      return { floor, gltf };
    } catch (err) {
      fracs[i] = 1;
      done += 1;
      tick();
      const msg = (err && err.message) ? err.message : String(err);
      state.errors.push({ key: floor.key, message: msg });
      console.error('[viewer] 楼层加载失败', floor.key, err);
      return { floor, gltf: null };
    }
  });

  let nextIdx = floors.length;
  let labelTask = Promise.resolve(null);
  if (hasLabels) {
    const idx = nextIdx;
    nextIdx += 1;
    const url = new URL(labelCfg.file, BASE_URL).href;
    labelTask = (async () => {
      try {
        const buf = await fetchBuffer(url, report(idx));
        fracs[idx] = 1;
        const gltf = await loader.parseAsync(buf, BASE_URL.href);
        done += 1;
        tick();
        return gltf;
      } catch (err) {
        // 标注资产是增强项：失败只记录，不报红条、不影响主模型
        fracs[idx] = 1;
        done += 1;
        tick();
        state.labels.error = (err && err.message) ? err.message : String(err);
        console.warn('[viewer] 砌块标注加载失败（已忽略）', err);
        return null;
      }
    })();
  }

  let edgeTask = Promise.resolve(null);
  if (hasEdges) {
    const idx = nextIdx;
    nextIdx += 1;
    const url = new URL(edgeCfg.file, BASE_URL).href;
    edgeTask = (async () => {
      try {
        const buf = await fetchBuffer(url, report(idx));
        fracs[idx] = 1;
        const gltf = await loader.parseAsync(buf, BASE_URL.href);
        done += 1;
        tick();
        return gltf;
      } catch (err) {
        fracs[idx] = 1;
        done += 1;
        tick();
        state.edges.error = (err && err.message) ? err.message : String(err);
        console.warn('[viewer] 砖边线层加载失败（已忽略）', err);
        return null;
      }
    })();
  }

  let elementsTask = Promise.resolve(null);
  if (hasElements) {
    const idx = nextIdx;
    nextIdx += 1;
    const url = new URL(elemsCfg.file, BASE_URL).href;
    elementsTask = (async () => {
      try {
        const buf = await fetchBuffer(url, report(idx));
        fracs[idx] = 1;
        done += 1;
        tick();
        const text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
        return JSON.parse(text);
      } catch (err) {
        fracs[idx] = 1;
        done += 1;
        tick();
        state.elements.error = (err && err.message) ? err.message : String(err);
        console.warn('[viewer] 构件信息 elements.json 加载失败（点选已禁用）', err);
        return null;
      }
    })();
  }

  const [floorResults, labelGltf, edgeGltf, elementsJson] = await Promise.all([
    Promise.all(floorTasks), labelTask, edgeTask, elementsTask,
  ]);
  draco.dispose();
  return { floorResults, labelGltf, edgeGltf, elementsJson };
}

/* ============================================================
 * 四、类别 / 墙厚 解析
 * ============================================================ */
/** 从节点名 / 材质名里提取原始类别串：C_QC__T100 -> QC__T100，C_L|F0_0 -> L */
function rawCodeOfName(name) {
  let s = String(name == null ? '' : name).trim();
  if (!s) return '';
  const i = s.indexOf('C_');
  if (i >= 0) s = s.slice(i + 2);
  s = s.split('|')[0].trim();
  return s;
}

/** 把原始串归一到 model.json 的类别 code。
 *  兼容：`C_QC`、`C_QC__T100`（墙厚子组）、被 three 唯一化后的 `QC_1`。 */
function resolveCode(raw) {
  const r = String(raw == null ? '' : raw).trim();
  if (!r) return 'UNKNOWN';
  const upper = r.toUpperCase();
  const cats = state.categories;
  if (!cats.length) return r;
  const byExact = (s) => cats.find((c) => c.code.toUpperCase() === s);

  let hit = byExact(upper);
  if (hit) return hit.code;

  const stripped = upper.replace(/[|_\-.]\d+$/, '');
  if (stripped !== upper) {
    hit = byExact(stripped);
    if (hit) return hit.code;
  }

  const sorted = cats.slice().sort((a, b) => b.code.length - a.code.length);
  for (const c of sorted) {
    const cc = c.code.toUpperCase();
    if (!cc || !upper.startsWith(cc)) continue;
    const next = upper.charAt(cc.length);
    if (!next || !/[A-Z]/.test(next)) return c.code;
  }

  const seg = upper.split(/[|_\-.\s]+/)[0];
  hit = byExact(seg);
  if (hit) return hit.code;
  return stripped || r;
}

function thicknessMap() {
  const map = new Map();
  state.thicknessGroups.forEach((g) => { map.set(g.code.toUpperCase(), g); });
  return map;
}

function resolveThicknessCode(raw) {
  const tmap = thicknessMap();
  if (!tmap.size) return '';
  const up = String(raw || '').toUpperCase();
  if (tmap.has(up)) return tmap.get(up).code;
  const stripped = up.replace(/[|_\-.]\d+$/, '');
  if (tmap.has(stripped)) return tmap.get(stripped).code;
  for (const [k, g] of tmap) {
    if (!up.startsWith(k)) continue;
    const rest = up.slice(k.length);
    // 后面只能是纯数字/分隔符数字（Blender 的 .001 后缀被 three 去点后变成 001）
    if (!rest || /^\d+$/.test(rest) || /^[.\-_]\d+$/.test(rest)) return g.code;
  }
  return up;
}

/** 返回 { code, sub }：code=类别 code，sub=墙厚子组 code（无则空串） */
function nodeCodeInfo(obj) {
  let raw = rawCodeOfName(obj.name);
  if (!raw) {
    let p = obj.parent;
    while (p && !raw) {
      if (p.name) raw = rawCodeOfName(p.name);
      p = p.parent;
    }
  }
  if (!raw) {
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (mat && mat.name) raw = rawCodeOfName(mat.name);
  }
  if (!raw) return { code: 'UNKNOWN', sub: '' };
  const parts = raw.split('__');
  let sub = '';
  if (parts.length > 1) sub = resolveThicknessCode(parts.slice(1).join('__'));
  return { code: resolveCode(parts[0]), sub };
}

function groupKey(code, sub) {
  return sub ? code + '__' + sub : code;
}

/* ============================================================
 * 五、合批：每层 × 每类别（× 墙厚） 合成一个 Mesh
 *     两层遍历：先统计顶点数预分配 Float32Array，再填充世界坐标。
 * ============================================================ */
function bakeFloor(gltfScene) {
  gltfScene.updateMatrixWorld(true);
  const expandedCache = new Map();
  const sources = new Set();
  const expanded = (geo) => {
    if (!geo.index) return geo;
    let g = expandedCache.get(geo);
    if (!g) { g = geo.toNonIndexed(); expandedCache.set(geo, g); }
    return g;
  };

  // pass 1：统计
  const meta = new Map();
  gltfScene.traverse((obj) => {
    if (!obj.isMesh) return;
    const { code, sub } = nodeCodeInfo(obj);
    const key = groupKey(code, sub);
    const geoSrc = obj.geometry;
    if (!geoSrc || !geoSrc.getAttribute('position')) return;
    sources.add(geoSrc);
    const geo = expanded(geoSrc);
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const inst = obj.isInstancedMesh ? obj.count : 1;
    let m = meta.get(key);
    if (!m) { m = { code, sub, verts: 0, count: 0, hasNormals: true, colorHex: null }; meta.set(key, m); }
    m.verts += pos.count * inst;
    m.count += inst;
    if (!(nrm && nrm.count === pos.count)) m.hasNormals = false;
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (!m.colorHex && mat && mat.color) m.colorHex = '#' + mat.color.getHexString();
  });

  const buckets = new Map();
  meta.forEach((m, key) => {
    buckets.set(key, {
      key,
      code: m.code,
      sub: m.sub,
      count: m.count,
      colorHex: m.colorHex,
      hasNormals: m.hasNormals,
      positions: new Float32Array(m.verts * 3),
      normals: m.hasNormals ? new Float32Array(m.verts * 3) : null,
      offset: 0,
      bmin: [Infinity, Infinity, Infinity],
      bmax: [-Infinity, -Infinity, -Infinity],
    });
  });

  // pass 2：烘焙世界坐标（GLB 已按绝对世界坐标导出，不做 elev 平移）
  const v = new THREE.Vector3();
  const instMat = new THREE.Matrix4();
  const nm3 = new THREE.Matrix3();
  gltfScene.traverse((obj) => {
    if (!obj.isMesh) return;
    const { code, sub } = nodeCodeInfo(obj);
    const b = buckets.get(groupKey(code, sub));
    if (!b) return;
    const geo = expanded(obj.geometry);
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    if (!pos) return;
    const matrices = [];
    if (obj.isInstancedMesh) {
      for (let i = 0; i < obj.count; i += 1) {
        obj.getMatrixAt(i, instMat);
        matrices.push(new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, instMat));
      }
    } else {
      matrices.push(obj.matrixWorld);
    }
    const P = b.positions;
    const N = b.normals;
    for (const m of matrices) {
      nm3.getNormalMatrix(m);
      let off = b.offset;
      const bmin = b.bmin;
      const bmax = b.bmax;
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        const px = v.x;
        const py = v.y;
        const pz = v.z;
        P[off] = px; P[off + 1] = py; P[off + 2] = pz;
        if (px < bmin[0]) bmin[0] = px;
        if (py < bmin[1]) bmin[1] = py;
        if (pz < bmin[2]) bmin[2] = pz;
        if (px > bmax[0]) bmax[0] = px;
        if (py > bmax[1]) bmax[1] = py;
        if (pz > bmax[2]) bmax[2] = pz;
        if (N && nrm) {
          v.fromBufferAttribute(nrm, i).applyMatrix3(nm3).normalize();
          N[off] = v.x; N[off + 1] = v.y; N[off + 2] = v.z;
        }
        off += 3;
      }
      b.offset = off;
    }
  });

  sources.forEach((g) => { try { g.dispose(); } catch (e) { /* ignore */ } });
  expandedCache.forEach((g) => { try { g.dispose(); } catch (e) { /* ignore */ } });
  return buckets;
}

function registerCategory(code, colorHex) {
  if (state.categories.some((c) => c.code === code)) return;
  state.categories.push({ code, label: code === 'UNKNOWN' ? '其他' : code, color: colorHex || '#b9c0c8' });
  state.catVisible[code] = true;
}

/** 颜色：QC 的墙厚子组用 thicknessGroups 的颜色；其它用 categories 的颜色 */
function getMaterial(key, code, sub) {
  let mat = state.materialsByCode.get(key);
  if (mat) return mat;
  let color = null;
  if (code === 'QC' && sub) {
    const g = thicknessMap().get(sub.toUpperCase());
    if (g) color = g.color;
  }
  if (!color) {
    const cat = state.categories.find((c) => c.code === code);
    color = (cat && cat.color) || '#b9c0c8';
  }
  const seeThrough = (code === 'M' || code === 'W' || code === 'G');   // 门、窗、幕墙玻璃：半透明，便于看后面的排砖
  mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.87,
    metalness: 0.02,
    side: THREE.DoubleSide,       // 剖切时保持双面可见
    transparent: seeThrough,
    opacity: seeThrough ? 0.32 : 1.0,
    depthWrite: !seeThrough,
    clippingPlanes: [state.clipPlane],
    clipShadows: false,
  });
  mat.name = 'mat_' + key;
  state.materialsByCode.set(key, mat);
  return mat;
}

function buildModel(results) {
  const root = state.model;
  state.bbox.makeEmpty();
  state.bboxRaw = null;
  state.pickables = [];

  // 先把所有楼层烘焙成顶点数组，再统一判断“主体锚点”，
  // 这样能剔除遗留在原点的原型/杂散构件（真实 Revit 绝对坐标常见）。
  const baked = [];
  results.forEach(({ floor, gltf }) => {
    if (!gltf || !gltf.scene) return;
    baked.push({ floor, buckets: bakeFloor(gltf.scene) });
  });
  if (!baked.length) return;

  // 选“主体锚点”：不是简单取顶点最多的块——某些类别块里可能混入原点原型，
  // 包围盒会被撑到几百米。这里先算所有块的包围盒对角线，取中位数，
  // 只把“尺寸正常”的块作为候选，再从中选顶点数最多的（通常是砌块主墙）。
  const diags = [];
  baked.forEach((item) => {
    item.buckets.forEach((b) => {
      if (!b.count || !b.bmin || !Number.isFinite(b.bmin[0])) return;
      const d = Math.hypot(b.bmax[0] - b.bmin[0], b.bmax[1] - b.bmin[1], b.bmax[2] - b.bmin[2]);
      b.diag = d;
      diags.push(d);
    });
  });
  diags.sort((x, y) => x - y);
  const medianDiag = diags.length ? diags[Math.floor(diags.length / 2)] : 1;
  const diagLimit = Math.max(medianDiag * 2.5, 5);
  let anchor = null;
  baked.forEach((item) => {
    item.buckets.forEach((b) => {
      if (!b.count || !b.bmin || !Number.isFinite(b.bmin[0])) return;
      if (b.diag > diagLimit) return; // 疑似混入原型的块，不参与锚点竞争
      // 用顶点数选主体（真实资产每类别是合并后的单个节点，count 恒为 1）
      if (!anchor || b.positions.length > anchor.positions.length) anchor = b;
    });
  });

  let dropped = 0;
  const dropInfo = [];
  if (anchor) {
    const ac = new THREE.Vector3(
      (anchor.bmin[0] + anchor.bmax[0]) / 2,
      (anchor.bmin[1] + anchor.bmax[1]) / 2,
      (anchor.bmin[2] + anchor.bmax[2]) / 2,
    );
    const adiag = Math.hypot(
      anchor.bmax[0] - anchor.bmin[0],
      anchor.bmax[1] - anchor.bmin[1],
      anchor.bmax[2] - anchor.bmin[2],
    );
    const limit = Math.max(120, adiag * 1.6);
    baked.forEach((item) => {
      item.buckets.forEach((b) => {
        if (!b.count || !b.bmin || !Number.isFinite(b.bmin[0])) return;
        const bx = (b.bmin[0] + b.bmax[0]) / 2;
        const by = (b.bmin[1] + b.bmax[1]) / 2;
        const bz = (b.bmin[2] + b.bmax[2]) / 2;
        const d = Math.hypot(bx - ac.x, by - ac.y, bz - ac.z);
        if (d > limit) {
          b.dropped = true;
          dropped += 1;
          dropInfo.push(item.floor.key + ':' + b.key + ' 距离主体 ' + Math.round(d) + 'm');
        }
      });
    });
    if (dropped) console.warn('[viewer] 已剔除远离主体的杂散几何：', dropInfo.join('；'));

    // 有些类别块里混有少量“模型原点原型”三角形：按主体包围盒逐个三角形剔除
    const keepBox = new THREE.Box3(
      new THREE.Vector3(anchor.bmin[0], anchor.bmin[1], anchor.bmin[2]),
      new THREE.Vector3(anchor.bmax[0], anchor.bmax[1], anchor.bmax[2]),
    ).expandByScalar(12);
    const a = new THREE.Vector3();
    const b2 = new THREE.Vector3();
    const c = new THREE.Vector3();
    const cen = new THREE.Vector3();
    let strayTris = 0;
    const strayWho = [];
    baked.forEach((item) => {
      item.buckets.forEach((bk) => {
        if (bk.dropped || !bk.positions || !bk.positions.length) return;
        const P = bk.positions;
        const N = bk.normals;
        const triCount = P.length / 9;
        const keepPos = [];
        const keepNrm = N ? [] : null;
        for (let t = 0; t < triCount; t += 1) {
          const o = t * 9;
          a.set(P[o], P[o + 1], P[o + 2]);
          b2.set(P[o + 3], P[o + 4], P[o + 5]);
          c.set(P[o + 6], P[o + 7], P[o + 8]);
          cen.copy(a).add(b2).add(c).multiplyScalar(1 / 3);
          if (keepBox.containsPoint(cen)) {
            for (let k = 0; k < 9; k += 1) keepPos.push(P[o + k]);
            if (keepNrm) for (let k = 0; k < 9; k += 1) keepNrm.push(N[o + k]);
          } else {
            strayTris += 1;
          }
        }
        if (keepPos.length === P.length) return;
        bk.positions = new Float32Array(keepPos);
        bk.normals = keepNrm ? new Float32Array(keepNrm) : null;
        bk.hasNormals = !!keepNrm;
        bk.bmin = [Infinity, Infinity, Infinity];
        bk.bmax = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < bk.positions.length; i += 3) {
          for (let k = 0; k < 3; k += 1) {
            if (bk.positions[i + k] < bk.bmin[k]) bk.bmin[k] = bk.positions[i + k];
            if (bk.positions[i + k] > bk.bmax[k]) bk.bmax[k] = bk.positions[i + k];
          }
        }
        if (!bk.positions.length) bk.dropped = true;
        strayWho.push(item.floor.key + ':' + bk.key);
      });
    });
    if (strayTris) {
      console.warn('[viewer] 剔除类别块内的杂散三角形 ' + strayTris +
        '（涉及 ' + strayWho.join('、') + '）');
    }
  }

  baked.forEach(({ floor, buckets }) => {
    const group = new THREE.Group();
    group.name = 'floor-' + floor.key;
    const meshes = [];
    let actualElements = 0;
    const actualByGroup = {};

    buckets.forEach((b, key) => {
      if (b.dropped) return;
      if (!b.count || !b.positions || !b.positions.length) return;
      registerCategory(b.code, b.colorHex);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
      if (b.hasNormals && b.normals && b.normals.length === b.positions.length) {
        geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
      } else {
        geo.computeVertexNormals();
      }
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, getMaterial(key, b.code, b.sub));
      mesh.name = 'F:' + floor.key + ':' + key;
      mesh.userData = { floor: floor.key, code: b.code, thickness: b.sub, elements: b.count };
      mesh.visible = true;
      group.add(mesh);
      meshes.push(mesh);
      state.pickables.push(mesh);
      actualElements += b.count;
      actualByGroup[key] = b.count;
      state.meshCount += 1;
      state.loadedNodes += b.count;
      state.triangles += b.positions.length / 9;
      state.bbox.union(geo.boundingBox);
    });

    if (!meshes.length) return;
    root.add(group);
    state.floorGroups.push({
      key: floor.key,
      label: floor.label,
      name: floor.name,
      elev: floor.elev,
      height: floor.height,
      counts: floor.counts,
      actualElements,
      actualByGroup,
      group,
      meshes,
    });
  });

  // 楼层按标高排序，避免 model.json 顺序异常导致面板乱序
  state.floorGroups.sort((a, b) => num(a.elev) - num(b.elev));

  // bbox 兜底：用 model.json 的 bbox
  if (state.bbox.isEmpty() && state.manifest && state.manifest.bbox) {
    const mn = state.manifest.bbox.min;
    const mx = state.manifest.bbox.max;
    if (Array.isArray(mn) && Array.isArray(mx)) {
      state.bbox.set(
        new THREE.Vector3(mn[0], mn[1], mn[2]),
        new THREE.Vector3(mx[0], mx[1], mx[2]),
      );
    }
  }
  if (state.bbox.isEmpty()) {
    state.bbox.set(new THREE.Vector3(-10, -1, -10), new THREE.Vector3(10, 10, 10));
  }

  // Revit 绝对坐标（可能离原点几百米以上）会让 float32 顶点抖动：
  // 把 X/Z 平移回原点附近，Y 保持绝对标高（剖切/标高标签仍准确）。
  state.bboxRaw = state.bbox.clone();
  const center = state.bbox.getCenter(new THREE.Vector3());
  const shiftX = Math.abs(center.x) > 50 ? center.x : 0;
  const shiftZ = Math.abs(center.z) > 50 ? center.z : 0;
  if (shiftX || shiftZ) {
    state.floorGroups.forEach((fg) => {
      fg.meshes.forEach((mesh) => {
        const pos = mesh.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i += 1) {
          pos.setX(i, pos.getX(i) - shiftX);
          pos.setZ(i, pos.getZ(i) - shiftZ);
        }
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      });
    });
    state.bbox.translate(new THREE.Vector3(-shiftX, 0, -shiftZ));
    state.worldShift = { x: shiftX, z: shiftZ };
  }
}

/* ============================================================
 * 六、砌块标注（labels.glb，独立加载，增强项）
 * ============================================================ */
function fixLabelMaterial(mat) {
  const mats = Array.isArray(mat) ? mat : [mat];
  mats.forEach((m) => {
    if (!m) return;
    m.alphaTest = 0.35;
    m.transparent = false;
    m.depthWrite = false;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    // 每块砌块两个大面各有一张贴片；用 DoubleSide 保证两面都能看到
    // （背面被砌块本身遮挡，不会出现"透视文字"；three 会自动翻转背面法线，光照正常）
    m.side = THREE.DoubleSide;
    m.needsUpdate = true;
    if (m.map) {
      m.map.anisotropy = 4;
      m.map.needsUpdate = true;
    }
  });
}

/** 计算 labels.glb 中落在主体范围内的贴片（不直接改几何，由调用方决定是否应用） */
function filterLabelGeometry(roots, keepBox) {
  const stat = { beforeTris: 0, afterTris: 0, removedTris: 0, meshes: 0 };
  const items = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  roots.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    stat.meshes += 1;
    const geo = obj.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const idx = geo.index;
    const total = idx ? idx.count : pos.count;
    stat.beforeTris += total / 3;
    const kept = [];
    for (let i = 0; i + 2 < total; i += 3) {
      const ia = idx ? idx.getX(i) : i;
      const ib = idx ? idx.getX(i + 1) : i + 1;
      const ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      if (keepBox.containsPoint(centroid)) kept.push(ia, ib, ic);
    }
    stat.afterTris += kept.length / 3;
    stat.removedTris += (total - kept.length) / 3;
    if (kept.length === total) return;
    const ng = new THREE.BufferGeometry();
    ['position', 'normal', 'uv'].forEach((name) => {
      const at = geo.getAttribute(name);
      if (!at) return;
      const itemSize = at.itemSize;
      const arr = new Float32Array(kept.length * itemSize);
      for (let j = 0; j < kept.length; j += 1) {
        const s = kept[j] * itemSize;
        for (let k = 0; k < itemSize; k += 1) arr[j * itemSize + k] = at.array[s + k];
      }
      ng.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
    });
    ng.computeBoundingSphere();
    items.push({ obj, ng, old: geo });
  });
  return { stat, items };
}

function buildLabels(gltf) {
  if (!gltf || !gltf.scene) return;
  const cfg = state.labels.cfg || {};
  const roots = gltf.scene;
  // 记录 labels.glb 原始坐标范围（便于排查坐标不一致问题）
  roots.updateMatrixWorld(true);
  try {
    const rawBox = new THREE.Box3().setFromObject(roots);
    if (!rawBox.isEmpty()) {
      state.labels.bounds = {
        min: rawBox.min.toArray().map((v) => Number(v.toFixed(3))),
        max: rawBox.max.toArray().map((v) => Number(v.toFixed(3))),
      };
    }
  } catch (e) { /* ignore */ }
  // 调试开关：?nofilter=1 时保留 labels.glb 原始几何（用于排查标注坐标问题）
  const skipFilter = /[?&]nofilter=1/.test(location.search);
  if (state.bboxRaw && !skipFilter) {
    const keepBox = state.bboxRaw.clone().expandByScalar(6);
    const { stat, items } = filterLabelGeometry(roots, keepBox);
    const ratio = stat.beforeTris ? stat.afterTris / stat.beforeTris : 1;
    state.labels.filter = Object.assign({ ratio: Number(ratio.toFixed(3)) }, stat);
    if (ratio < 0.2) {
      // 标注坐标与模型对不上（整批贴片落在主体范围外）→ 不显示，避免错误标注
      items.forEach(({ ng }) => { try { ng.dispose(); } catch (e) { /* ignore */ } });
      state.labels.invalid = true;
      state.labels.loaded = true;
      state.labels.on = false;
      console.warn('[viewer] 标注坐标与模型不匹配（' + stat.afterTris + ' / ' +
        stat.beforeTris + ' 贴片在模型范围内），已跳过标注显示');
      return;
    }
    items.forEach(({ obj, ng, old }) => {
      obj.geometry = ng;
      try { old.dispose(); } catch (e) { /* ignore */ }
    });
    if (stat.removedTris) {
      console.warn('[viewer] 标注剔除杂散贴片三角形 ' + stat.removedTris +
        ' / ' + stat.beforeTris + '（保留 ' + stat.afterTris + '）');
    }
  }
  roots.updateMatrixWorld(true);
  roots.traverse((obj) => {
    if (!obj.isMesh) return;
    fixLabelMaterial(obj.material);
    obj.renderOrder = 10;
    obj.frustumCulled = true;
  });
  roots.position.set(-state.worldShift.x, 0, -state.worldShift.z);
  state.scene.add(roots);
  state.labels.root = roots;

  const map = {};
  const missing = [];
  if (cfg.nodes && typeof cfg.nodes === 'object') {
    Object.entries(cfg.nodes).forEach(([floorKey, nodeName]) => {
      const node = roots.getObjectByName(nodeName);
      if (node) map[floorKey] = node;
      else missing.push(floorKey);
    });
  }
  // 兜底：nodes 映射缺失 / 全对不上时，按场景里 L_ 开头的节点自动匹配楼层 key
  if (!Object.keys(map).length) {
    roots.traverse((obj) => {
      if (!obj.name) return;
      const n = String(obj.name);
      const suffix = /^L_(.+)$/.exec(n);
      if (!suffix) return;
      const raw = suffix[1];
      const hit = state.floors.find((f) => f.key === raw || f.key === raw.replace(/^F0?/, 'F') ||
        ('L_' + f.key) === n || n === 'L_' + f.key);
      const key = hit ? hit.key : raw;
      map[key] = obj;
    });
    if (Object.keys(map).length) console.warn('[viewer] 标注节点按名称自动匹配', Object.keys(map));
  }
  if (missing.length) {
    // 某些楼层没有砌块（纯结构层）时本来就没有标注，不必逐层告警
    console.warn('[viewer] 标注节点缺失：' + missing.join(' / '));
  }
  state.labels.nodesByFloor = map;
  state.labels.loaded = true;
  if (window.__viewer) window.__viewer.labelsRoot = state.labels.root;
  applyLabelsVisibility();
}

function applyLabelsVisibility() {
  const L = state.labels;
  if (!L.root) return;
  const qcOn = !!state.catVisible['QC'];
  const base = L.loaded && L.on && L.near && qcOn;
  Object.entries(L.nodesByFloor).forEach(([floorKey, node]) => {
    const floorVisible = state.selectedFloor === 'all' || state.selectedFloor === floorKey;
    node.visible = base && floorVisible;
  });
}

/** 一键拉近到近景墙面：让砖上的尺寸标注清晰可见（整栋远景下字太小） */
function flyToLabelView() {
  const cam = state.camera, ctl = state.controls;
  if (!cam || !ctl || !state.bbox) return false;
  const b = state.bbox;
  const center = new THREE.Vector3(
    (b.min.x + b.max.x) / 2,
    (b.min.y + b.max.y) / 2,
    (b.min.z + b.max.z) / 2,
  );
  const dir = cam.position.clone().sub(ctl.target);
  if (dir.lengthSq() < 1e-8) dir.set(0.75, 0.45, 0.75);
  dir.normalize();
  const box = b.getSize(new THREE.Vector3());
  const dist = Math.max(9, Math.min(13, Math.min(box.x, box.z) * 0.55 || 11));
  ctl.target.copy(center);
  cam.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  ctl.update();
  state.userMoved = true;
  try { toast('已拉近近景：砖上标注可见；点「复位视角」回看整栋', 3200); } catch (e) {}
  return true;
}

function updateLabelsLOD() {
  const L = state.labels;
  if (!L.loaded || !L.cfg || !state.camera) return;
  // 用“相机到模型包围盒的最短距离”做 LOD：
  // 对住宅楼这种 4 栋并排、跨度 169m 的模型，按包围盒中心算会永远看不到标注；
  // 按包围盒距离则“靠近任意一栋就显示、拉远就隐藏”，更符合使用直觉。
  // 显示距离：至少 30m（manifest 里的 16m 对手机远景太近，放宽到 30m）
  const near = state.bbox.distanceToPoint(state.camera.position) <=
    Math.max(30, Number(L.cfg.lodDistance) || 30);
  if (near !== L.near) {
    L.near = near;
    applyLabelsVisibility();
    updateInfoDynamic();
  }
}

/* ============================================================
 * 六·B、砖边线 / 灰缝层（独立 GLB，按楼层同步显隐，不做距离 LOD）
 * ============================================================ */
function fixEdgesMaterial(mat) {
  const mats = Array.isArray(mat) ? mat : [mat];
  mats.forEach((m) => {
    if (!m) return;
    // 边线图集很小（128×128，线像素 alpha≈0.47~0.92），远景 mipmap 平均后 alpha 会掉到
    // 0.35 的 alphaTest 以下而整层消失；这里用很低的 alphaTest + BLEND 保证远近都能看到分格。
    m.alphaTest = 0.02;
    m.transparent = true;
    m.opacity = 1;
    m.depthWrite = false;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.side = THREE.DoubleSide;
    m.needsUpdate = true;
    if (m.map) {
      m.map.minFilter = THREE.LinearFilter; // 避免 mipmap 把细线 alpha 平均光
      m.map.generateMipmaps = false;
      m.map.needsUpdate = true;
    }
  });
}

function buildEdges(gltf) {
  if (!gltf || !gltf.scene) {
    state.edges.loaded = false;
    updateInfoDynamic();
    return;
  }
  const cfg = state.edges.cfg || {};
  const roots = gltf.scene;
  roots.updateMatrixWorld(true);
  roots.traverse((obj) => {
    if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
    fixEdgesMaterial(obj.material);
    obj.renderOrder = 10;
    obj.frustumCulled = true;
  });
  roots.position.set(-state.worldShift.x, 0, -state.worldShift.z);
  state.scene.add(roots);
  state.edges.root = roots;

  const map = {};
  if (cfg.nodes && typeof cfg.nodes === 'object') {
    Object.entries(cfg.nodes).forEach(([floorKey, nodeName]) => {
      const node = roots.getObjectByName(nodeName);
      if (node) map[floorKey] = node;
    });
  }
  if (!Object.keys(map).length) {
    roots.traverse((obj) => {
      const n = String(obj.name || '');
      const m2 = /^E_(.+)$/.exec(n);
      if (!m2) return;
      const raw = m2[1];
      const hit = state.floors.find((f) => f.key === raw || ('E_' + f.key) === n);
      map[hit ? hit.key : raw] = obj;
    });
  }
  state.edges.nodesByFloor = map;
  state.edges.loaded = true;
  if (window.__viewer) window.__viewer.edgesRoot = state.edges.root;
  applyEdgesVisibility();
  updateInfoDynamic();
}

function applyEdgesVisibility() {
  const E = state.edges;
  if (!E.root) return;
  const base = E.loaded && E.on;
  Object.entries(E.nodesByFloor).forEach(([floorKey, node]) => {
    const floorVisible = state.selectedFloor === 'all' || state.selectedFloor === floorKey;
    node.visible = base && floorVisible;
  });
}

function setEdges(on) {
  const next = typeof on === 'boolean' ? on : !state.edges.on;
  state.edges.on = next;
  applyEdgesVisibility();
  updateInfoDynamic();
  return stats();
}

/* ============================================================
 * 六·C、构件点选（elements.json 空间索引 + raycast + 信息卡）
 * ============================================================ */
function buildElements(json) {
  const E = state.elements;
  E.ready = false;
  if (!json || !Array.isArray(json.rows) || !json.rows.length) {
    E.error = json ? 'elements.json rows 为空' : E.error;
    updateInfoDynamic();
    return;
  }
  E.meta = {
    units: json.units || 'm',
    coord: json.coord || 'gltf',
    floors: Array.isArray(json.floors) ? json.floors : [],
    categories: Array.isArray(json.categories) ? json.categories : [],
    families: Array.isArray(json.families) ? json.families : [],
    specs: Array.isArray(json.specs) ? json.specs : [],
  };
  E.rows = json.rows;
  E.count = json.rows.length;
  E.floorKeyToIdx = new Map();
  E.meta.floors.forEach((k, i) => E.floorKeyToIdx.set(String(k), i));
  E.floorRows = new Map();
  E.grid = new Map();
  E.allRows = new Array(E.count);
  const cell = E.cell;
  for (let i = 0; i < E.count; i += 1) {
    const r = E.rows[i];
    E.allRows[i] = i;
    const hi = r[0];
    let list = E.floorRows.get(hi);
    if (!list) { list = []; E.floorRows.set(hi, list); }
    list.push(i);
    const x0 = Math.min(r[5], r[8]);
    const x1 = Math.max(r[5], r[8]);
    const z0 = Math.min(r[7], r[10]);
    const z1 = Math.max(r[7], r[10]);
    const gx0 = Math.floor(x0 / cell);
    const gx1 = Math.floor(x1 / cell);
    const gz0 = Math.floor(z0 / cell);
    const gz1 = Math.floor(z1 / cell);
    if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > 256) continue; // 超大构件不进网格，仍可用楼层兜底
    for (let gx = gx0; gx <= gx1; gx += 1) {
      for (let gz = gz0; gz <= gz1; gz += 1) {
        const key = gx + '|' + gz;
        let arr = E.grid.get(key);
        if (!arr) { arr = []; E.grid.set(key, arr); }
        arr.push(i);
      }
    }
  }
  E.byRevitId = new Map();
  for (let i = 0; i < E.count; i += 1) {
    const rid = E.rows[i][4];
    if (rid != null && rid !== '') E.byRevitId.set(String(rid), i);
  }
  E.ready = true;
  E.error = null;
  updateInfoDynamic();
}

/** 在 elements.json 中查找包含 world 点的构件（多命中取体积最小），找不到取最近中心 ≤0.3m */
function findElementAt(wx, wy, wz, floorKeyHint) {
  const E = state.elements;
  if (!E.ready) return -1;
  const rows = E.rows;
  const floorIdx = (floorKeyHint != null && E.floorKeyToIdx.has(floorKeyHint))
    ? E.floorKeyToIdx.get(floorKeyHint) : null;
  const tried = new Set();
  let best = -1;
  let bestVol = Infinity;
  const catCodes = E.meta.categories;
  const floorKeys = E.meta.floors;
  const isRowVisible = (idx) => {
    const r = rows[idx];
    const code = catCodes[r[1]];
    if (code && state.catVisible && state.catVisible[code] === false) return false;
    const fk = floorKeys[r[0]];
    if (state.selectedFloor !== 'all' && fk && fk !== state.selectedFloor) return false;
    return true;
  };
  const consider = (idx) => {
    if (tried.has(idx)) return;
    tried.add(idx);
    const r = rows[idx];
    if (floorIdx != null && r[0] !== floorIdx) return;
    if (!isRowVisible(idx)) return;
    const mnx = Math.min(r[5], r[8]);
    const mxx = Math.max(r[5], r[8]);
    const mny = Math.min(r[6], r[9]);
    const mxy = Math.max(r[6], r[9]);
    const mnz = Math.min(r[7], r[10]);
    const mxz = Math.max(r[7], r[10]);
    if (wx < mnx - 0.01 || wx > mxx + 0.01) return;
    if (wy < mny - 0.01 || wy > mxy + 0.01) return;
    if (wz < mnz - 0.01 || wz > mxz + 0.01) return;
    const vol = (mxx - mnx) * (mxy - mny) * (mxz - mnz);
    if (vol < bestVol) { bestVol = vol; best = idx; }
  };
  const cell = E.cell;
  const gx = Math.floor(wx / cell);
  const gz = Math.floor(wz / cell);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const arr = E.grid.get((gx + dx) + '|' + (gz + dz));
      if (arr) arr.forEach(consider);
    }
  }
  if (best >= 0) return best;
  // 兜底：同楼层内找最近中心（≤0.3m）
  const list = floorIdx != null ? (E.floorRows.get(floorIdx) || []) : E.allRows;
  let nearest = -1;
  let nd = 0.3;
  for (let k = 0; k < list.length; k += 1) {
    const i = list[k];
    if (!isRowVisible(i)) continue;
    const r = rows[i];
    const cx = (r[5] + r[8]) / 2;
    const cy = (r[6] + r[9]) / 2;
    const cz = (r[7] + r[10]) / 2;
    const d = Math.hypot(cx - wx, cy - wy, cz - wz);
    if (d < nd) { nd = d; nearest = i; }
  }
  return nearest;
}

function elementInfo(index) {
  const E = state.elements;
  if (!E.ready || !E.rows) return null;
  const r = E.rows[index];
  if (!r) return null;
  const floorKey = E.meta.floors[r[0]] != null ? String(E.meta.floors[r[0]]) : '';
  const catCode = E.meta.categories[r[1]] != null ? String(E.meta.categories[r[1]]) : '';
  const family = E.meta.families[r[2]] != null ? String(E.meta.families[r[2]]) : '';
  const spec = E.meta.specs[r[3]] != null ? String(E.meta.specs[r[3]]) : '';
  const revitId = r[4] == null ? '' : String(r[4]);
  const mnx = Math.min(r[5], r[8]);
  const mxx = Math.max(r[5], r[8]);
  const mny = Math.min(r[6], r[9]);
  const mxy = Math.max(r[6], r[9]);
  const mnz = Math.min(r[7], r[10]);
  const mxz = Math.max(r[7], r[10]);
  const shift = state.worldShift;
  const fg = state.floorGroups.find((f) => f.key === floorKey);
  const cat = state.categories.find((c) => c.code === catCode);
  const sizeL = mxx - mnx;
  const sizeW = mxz - mnz;
  const sizeH = mxy - mny;
  const centerDisplay = [
    (mnx + mxx) / 2 - shift.x,
    (mny + mxy) / 2,
    (mnz + mxz) / 2 - shift.z,
  ];
  return {
    index,
    floorKey,
    floorLabel: (fg && fg.label) || floorKey,
    catCode,
    catLabel: (cat && cat.label) || catCode,
    family,
    spec,
    revitId,
    size: [sizeL, sizeW, sizeH],
    center: centerDisplay,
    bboxWorld: [mnx, mny, mnz, mxx, mxy, mxz],
    bboxDisplay: [mnx - shift.x, mny, mnz - shift.z, mxx - shift.x, mxy, mxz - shift.z],
  };
}

function ensureHighlight() {
  if (state.highlight) return state.highlight;
  const group = new THREE.Group();
  group.name = 'selection-highlight';
  const box = new THREE.Box3Helper(new THREE.Box3(), 0xff8a1e);
  box.material.depthTest = false;
  box.material.transparent = true;
  box.material.opacity = 0.95;
  box.renderOrder = 20;
  group.add(box);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xff8a1e, transparent: true, opacity: 0.14, depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glowMat);
  glow.renderOrder = 19;
  group.add(glow);
  group.visible = false;
  state.scene.add(group);
  state.highlight = { group, box, glow };
  return state.highlight;
}

function updateHighlight(info) {
  const h = ensureHighlight();
  if (!info) { h.group.visible = false; return; }
  const b = info.bboxDisplay;
  const pad = 0.012;
  const box3 = new THREE.Box3(
    new THREE.Vector3(b[0] - pad, b[1] - pad, b[2] - pad),
    new THREE.Vector3(b[3] + pad, b[4] + pad, b[5] + pad),
  );
  h.box.box.copy(box3);
  h.glow.position.copy(box3.getCenter(new THREE.Vector3()));
  h.glow.scale.set(
    Math.max(0.02, box3.max.x - box3.min.x),
    Math.max(0.02, box3.max.y - box3.min.y),
    Math.max(0.02, box3.max.z - box3.min.z),
  );
  h.group.visible = true;
  applySelectionVisibility();
}

function applySelectionVisibility() {
  const h = state.highlight;
  const sel = state.selection;
  if (!h) return;
  if (!sel) { h.group.visible = false; return; }
  const floorVisible = state.selectedFloor === 'all' || state.selectedFloor === sel.floorKey;
  const catVisible = !!state.catVisible[sel.catCode];
  h.group.visible = floorVisible && catVisible;
}

function fillInfoCard(info) {
  if (!ui.infoCard) return;
  if (!info) { ui.infoCard.hidden = true; return; }
  ui.infoCard.hidden = false;
  const sizeText = info.size.map((v) => v.toFixed(3)).join(' × ');
  const centerText = info.center.map((v) => v.toFixed(3)).join(', ');
  const rows = [
    ['楼层', info.floorLabel],
    ['类别', info.catLabel],
    ['族名', info.family || '—'],
    ['规格', info.spec || '—'],
    ['尺寸 L×W×H', sizeText + ' m'],
    ['中心坐标', centerText + ' m'],
    ['Revit 元素 ID', info.revitId || '—'],
  ];
  ui.icList.innerHTML = rows.map((r) =>
    '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('');
}

function syncSelectionUrl(info) {
  try {
    const u = new URL(location.href);
    if (info && info.revitId) u.searchParams.set('el', info.revitId);
    else u.searchParams.delete('el');
    history.replaceState(null, '', u.toString());
  } catch (e) { /* ignore */ }
}

function selectByRevitId(id) {
  const E = state.elements;
  if (!E.ready || !E.byRevitId) return null;
  const idx = E.byRevitId.get(String(id));
  if (idx == null) return null;
  return selectElement(idx);
}

function selectElement(index) {
  if (!state.elements.ready) return null;
  const info = elementInfo(index);
  if (!info) return null;
  state.selection = info;
  updateHighlight(info);
  fillInfoCard(info);
  if (window.innerWidth < 768 && ui.panel && !ui.panel.classList.contains('is-collapsed')) {
    state.sheetTouched = true;
    ui.panel.classList.add('is-collapsed');
  }
  syncSelectionUrl(info);
  // 本地版（127.0.0.1 / localhost）把选中构件回传给本地服务，便于协作方直接读取
  try {
    if (/(^|\.)(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      const payload = {
        page: location.pathname,
        url: location.href,
        selection: getSelection(),
        info: info,
        ts: new Date().toISOString(),
      };
      fetch('/__selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () { /* 本地服务未开时静默 */ });
    }
  } catch (e) { /* ignore */ }
  return info;
}

function clearSelection() {
  state.selection = null;
  if (state.highlight) state.highlight.group.visible = false;
  fillInfoCard(null);
  syncSelectionUrl(null);
  return true;
}

function getSelection() {
  const sel = state.selection;
  if (!sel) return null;
  return {
    index: sel.index,
    floorKey: sel.floorKey,
    floorLabel: sel.floorLabel,
    category: sel.catCode,
    categoryLabel: sel.catLabel,
    family: sel.family,
    spec: sel.spec,
    revitId: sel.revitId,
    size: sel.size.map((v) => Number(v.toFixed(3))),
    center: sel.center.map((v) => Number(v.toFixed(3))),
    bboxWorld: sel.bboxWorld.map((v) => Number(v.toFixed(3))),
  };
}

function selectionText(info) {
  if (!info) return '';
  const title = (state.manifest && state.manifest.title) || '';
  return [
    title, info.floorLabel, info.catLabel, info.family, info.spec,
    'L×W×H=' + info.size.map((v) => v.toFixed(3)).join('×') + 'm',
    '中心(' + info.center.map((v) => v.toFixed(3)).join(', ') + ')',
    'RevitID=' + (info.revitId || '—'),
  ].join(' | ');
}

function hideSelectedElement() {
  const info = state.selection;
  if (!info) return false;
  const isLocal = /(^|\.)(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (!isLocal) { toast('隐藏构件只在本地版可用（线上版请把 Revit 元素 ID 发我）', 3200); return false; }
  if (!info.revitId) { toast('该构件没有 Revit 元素 ID，无法加入排除清单', 3000); return false; }
  fetch('/__exclude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: location.pathname, revitId: info.revitId }),
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.state === 'busy') {
      toast('已有重建任务在进行，稍后会自动刷新', 4000);
      pollRebuild();
      return;
    }
    toast('已加入排除清单，正在后台重建模型（约 3~8 分钟），完成后自动刷新', 6000);
    pollRebuild();
  }).catch(function () {
    toast('本地服务没响应：请确认本地版服务在运行', 4000);
  });
  return true;
}

function pollRebuild() {
  let tries = 0;
  const timer = setInterval(function () {
    tries += 1;
    fetch('/__exclude_status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.state === 'done') {
          clearInterval(timer);
          toast('重建完成，正在刷新…', 3000);
          setTimeout(function () { location.reload(); }, 900);
        } else if (s && s.state === 'error') {
          clearInterval(timer);
          toast('重建失败：' + (s.log || '').slice(-200), 8000);
        }
      })
      .catch(function () { /* ignore */ });
    if (tries > 240) clearInterval(timer);
  }, 5000);
}

function copySelection() {
  const info = state.selection;
  if (!info) return false;
  const text = selectionText(info);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制构件信息', 2200),
        () => fallbackCopy(text),
      );
      return true;
    }
  } catch (e) { /* ignore */ }
  fallbackCopy(text);
  return true;
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('已复制构件信息', 2200);
  } catch (e) {
    toast('复制失败，请手动选择信息文本');
  }
}

let _raycaster = null;
/** 按屏幕坐标点选构件，返回选中信息（无命中返回 null 并清除选中） */
function pickAt(clientX, clientY) {
  if (!state.elements.ready || !state.camera || !state.renderer) return null;
  const rect = state.renderer.domElement.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
  if (!_raycaster) _raycaster = new THREE.Raycaster();
  _raycaster.setFromCamera(new THREE.Vector2(nx, ny), state.camera);
  const hits = _raycaster.intersectObjects(state.pickables, false);
  if (!hits.length) { clearSelection(); return null; }
  const hit = hits[0];
  const shift = state.worldShift;
  const wx = hit.point.x + shift.x;
  const wy = hit.point.y;
  const wz = hit.point.z + shift.z;
  const floorKey = (hit.object.userData && hit.object.userData.floor) || null;
  const idx = findElementAt(wx, wy, wz, floorKey);
  if (idx < 0) { clearSelection(); return null; }
  return selectElement(idx);
}

/* 地面 + 网格（随 bbox 生成，只建一次） */
function buildGround() {
  const box = state.bbox;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 10) * 1.9;
  const y = box.min.y - 0.03;

  const groundGeo = new THREE.PlaneGeometry(span, span);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xdfe6ee, roughness: 1, metalness: 0, side: THREE.FrontSide,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, y, center.z);
  ground.renderOrder = -1;
  state.scene.add(ground);
  state.ground = ground;

  const grid = new THREE.GridHelper(span, Math.max(8, Math.round(span)), 0x8fa0b4, 0xc2ccd8);
  grid.name = 'grid';
  grid.position.set(center.x, y + 0.006, center.z);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  grid.visible = false;
  grid.renderOrder = 0;
  state.scene.add(grid);
  state.grid = grid;
}

/* ============================================================
 * 七、交互：楼层 / 类别 / 墙厚 / 剖切 / 网格 / 标注 / 视角
 * ============================================================ */
function floorElevText(elev) {
  const v = num(elev);
  return '标高 ' + (v >= 0 ? '+' : '') + v.toFixed(3);
}

function floorMetaText(fg) {
  const parts = [];
  if (fg.height != null) parts.push('层高 ' + fmt2(fg.height) + ' m');
  if (!/^标高/.test(fg.label || '')) parts.push(floorElevText(fg.elev));
  if (!parts.length) parts.push(floorElevText(fg.elev));
  return parts.join(' · ');
}

function buildFloorPanel() {
  const items = [];
  let totalElements = 0;
  let totalBlocks = 0;
  state.floorGroups.forEach((fg) => {
    const r = floorCountSum(fg, false);
    totalElements += r.elements;
    totalBlocks += r.blocks;
  });
  items.push(
    '<button class="floor-item f-all' + (state.selectedFloor === 'all' ? ' active' : '') +
    '" data-key="all" type="button"><span class="f-key">ALL</span>' +
    '<span class="f-body"><span class="f-label">全部楼层</span>' +
    '<span class="f-meta">' + state.floorGroups.length + ' 层 · 合计 ' +
    fmt(totalElements) + ' 件</span></span>' +
    '<span class="f-count" title="砌块合计">' + fmt(totalBlocks) + '</span></button>',
  );
  for (const fg of state.floorGroups) {
    const r = floorCountSum(fg, false);
    // 楼层行优先显示该层砌块数；纯结构层（0 块）显示“结构层”
    const badge = r.blocks > 0
      ? '<span class="f-count" title="砌块 ' + fmt(r.blocks) + ' 块 / 构件 ' + fmt(r.elements) + ' 件">' +
        fmt(r.blocks) + '</span>'
      : '<span class="f-count f-count-struct" title="砌块 0 块 / 构件 ' + fmt(r.elements) +
        ' 件">结构层</span>';
    items.push(
      '<button class="floor-item' + (state.selectedFloor === fg.key ? ' active' : '') +
      '" data-key="' + esc(fg.key) + '" type="button"' +
      ' title="' + esc((fg.name || '') + ' · 砌块 ' + fmt(r.blocks) + ' 块 / 构件 ' +
        fmt(r.elements) + ' 件') + '">' +
      '<span class="f-key">' + esc(fg.key) + '</span>' +
      '<span class="f-body"><span class="f-label">' + esc(fg.label || fg.key) + '</span>' +
      '<span class="f-meta">' + esc(floorMetaText(fg)) + '</span></span>' +
      badge + '</button>',
    );
  }
  if (state.hideFloorPanel) {
    // 只显示指定楼层：隐藏“楼层”选择区（含“全部楼层”）
    const sec = ui.floorList.closest('section');
    if (sec) sec.style.display = 'none';
    ui.floorList.style.display = 'none';
    return;
  }
  ui.floorList.innerHTML = items.join('');
  ui.floorList.querySelectorAll('.floor-item').forEach((btn) => {
    btn.addEventListener('click', () => setFloor(btn.dataset.key));
  });
}

function categoryTotals() {
  const totals = {};
  const tmap = thicknessMap();
  const hasQCKey = state.floorGroups.some((f) => f.counts && Object.prototype.hasOwnProperty.call(f.counts, 'QC'));
  for (const fg of state.floorGroups) {
    if (fg.counts) {
      Object.entries(fg.counts).forEach(([code, n]) => {
        const isT = tmap.has(code.toUpperCase());
        if (isT && hasQCKey) return; // QC 键已含全部砌块，厚度子键只是子集
        const target = isT ? 'QC' : code;
        totals[target] = (totals[target] || 0) + num(n);
      });
    } else {
      fg.meshes.forEach((m) => {
        const c = m.userData.code;
        totals[c] = (totals[c] || 0) + m.userData.elements;
      });
    }
  }
  return totals;
}

function thicknessTotals() {
  const totals = {};
  if (state.thicknessGroups.length) {
    let any = false;
    state.thicknessGroups.forEach((g) => {
      const v = Number(g.count);
      if (Number.isFinite(v) && v > 0) any = true;
      totals[g.code] = num(v);
    });
    if (any) return totals;
  }
  // 兜底：从 floors[].counts 的墙厚键累加
  const tmap = thicknessMap();
  state.thicknessGroups.forEach((g) => { totals[g.code] = 0; });
  for (const fg of state.floorGroups) {
    if (!fg.counts) continue;
    Object.entries(fg.counts).forEach(([code, n]) => {
      const g = tmap.get(code.toUpperCase());
      if (g) totals[g.code] += num(n);
    });
  }
  return totals;
}

function thicknessSwatchStyle() {
  const groups = state.thicknessGroups;
  if (!groups.length) return '';
  if (groups.length === 1) return 'background:' + groups[0].color;
  const step = 100 / groups.length;
  const stops = groups.map((g, i) =>
    g.color + ' ' + (i * step).toFixed(1) + '% ' + ((i + 1) * step).toFixed(1) + '%');
  return 'background:linear-gradient(135deg,' + stops.join(',') + ')';
}

function buildCategoryPanel() {
  const totals = categoryTotals();
  const tTotals = thicknessTotals();
  const parts = [];
  state.categories.forEach((c) => {
    const on = !!state.catVisible[c.code];
    const hasChildren = c.code === 'QC' && state.thicknessGroups.length > 0;
    const count = hasChildren
      ? state.thicknessGroups.reduce((a, g) => a + num(tTotals[g.code]), 0) || totals[c.code] || 0
      : (totals[c.code] || 0);
    const swStyle = hasChildren ? thicknessSwatchStyle() : 'background:' + esc(c.color);
    parts.push(
      '<label class="cat-item' + (on ? '' : ' off') + '" data-code="' + esc(c.code) + '">' +
      '<span class="swatch" style="' + swStyle + '"></span>' +
      '<span class="cat-name">' + esc(c.label) + '</span>' +
      '<span class="cat-count">' + fmt(count) + '</span>' +
      '<input class="switch" type="checkbox" data-code="' + esc(c.code) + '"' +
      (on ? ' checked' : '') + ' aria-label="' + esc(c.label) + '"></label>',
    );
    if (hasChildren) {
      state.thicknessGroups.forEach((g) => {
        const gon = on && !!state.thicknessVisible[g.code];
        parts.push(
          '<label class="cat-item cat-sub' + (gon ? '' : ' off') + '" data-thickness="' + esc(g.code) + '">' +
          '<span class="swatch swatch-sm" style="background:' + esc(g.color) + '"></span>' +
          '<span class="cat-name">' + esc(g.label) + '</span>' +
          '<span class="cat-count">' + fmt(tTotals[g.code]) + '</span>' +
          '<input class="switch switch-sm" type="checkbox" data-thickness="' + esc(g.code) + '"' +
          (gon ? ' checked' : '') + ' aria-label="' + esc(g.label) + '"></label>',
        );
      });
    }
  });
  ui.catList.innerHTML = parts.join('');
  ui.catList.querySelectorAll('input.switch[data-code]').forEach((input) => {
    input.addEventListener('change', () => toggleCategory(input.dataset.code, input.checked));
  });
  ui.catList.querySelectorAll('input.switch[data-thickness]').forEach((input) => {
    input.addEventListener('change', () => toggleThickness(input.dataset.thickness, input.checked));
  });
}

function setFloor(key) {
  const next = key && key !== 'all' ? key : 'all';
  if (next === state.selectedFloor) state.selectedFloor = 'all';   // 再点同一层 = 取消
  else state.selectedFloor = next;
  applyVisibility();
  return stats();
}

function setShowAllFloors() {
  state.selectedFloor = 'all';
  applyVisibility();
  return stats();
}

function toggleCategory(code, force) {
  if (!(code in state.catVisible)) return stats();
  const next = typeof force === 'boolean' ? force : !state.catVisible[code];
  state.catVisible[code] = next;
  // 父项联动全部墙厚子项
  if (code === 'QC' && state.thicknessGroups.length) {
    state.thicknessGroups.forEach((g) => { state.thicknessVisible[g.code] = next; });
  }
  applyVisibility();
  return stats();
}

function toggleThickness(code, force) {
  const g = thicknessMap().get(String(code).toUpperCase());
  if (!g) return stats();
  state.thicknessVisible[g.code] = typeof force === 'boolean' ? force : !state.thicknessVisible[g.code];
  // 子项联动父项：有任何子项开 → QC 类别开；全关 → QC 类别关
  const anyOn = state.thicknessGroups.some((x) => state.thicknessVisible[x.code]);
  state.catVisible.QC = anyOn;
  applyVisibility();
  return stats();
}

function setClip(y) {
  const box = state.bbox;
  if (y == null || !Number.isFinite(Number(y))) {
    state.clipEnabled = false;
    state.clipY = null;
    state.clipPlane.constant = box.max.y + 1e4;   // 等价于不剖切
    updateClipUI();
    return stats();
  }
  const minY = box.min.y - 0.01;
  const maxY = box.max.y;
  const yy = Math.max(minY, Math.min(maxY, Number(y)));
  state.clipEnabled = true;
  state.clipY = yy;
  state.clipPlane.constant = yy;
  updateClipUI();
  return stats();
}

function setGrid(on) {
  state.showGrid = typeof on === 'boolean' ? on : !state.showGrid;
  if (state.grid) state.grid.visible = state.showGrid;
  ui.btnGrid.setAttribute('aria-pressed', state.showGrid ? 'true' : 'false');
  return stats();
}

function setLabels(on) {
  const L = state.labels;
  const next = typeof on === 'boolean' ? on : !L.on;
  if (L.invalid) {
    toast('标注与模型坐标不一致，已跳过（请检查 labels.glb）');
    updateInfoDynamic();
    return stats();
  }
  // 手机端按需加载标注资产，避免一进页面就解码 4096 级图集
  if (next && L.cfg && !L.loaded && !L.loading) {
    ui.btnLabels.setAttribute('aria-pressed', 'false');
    ensureLabelsLoaded().then((ok) => {
      if (ok) {
        L.on = true;
        applyLabelsVisibility();
        updateInfoDynamic();
      }
    });
    return stats();
  }
  L.on = next;
  ui.btnLabels.setAttribute('aria-pressed', next && L.loaded ? 'true' : 'false');
  applyLabelsVisibility();
  updateInfoDynamic();
  return stats();
}

/** 按需加载 labels.glb（手机端默认延迟到用户开启标注时） */
async function ensureLabelsLoaded() {
  const L = state.labels;
  if (L.loaded || L.loading || !L.cfg) return L.loaded;
  L.loading = true;
  updateInfoDynamic();
  toast('正在加载砌块标注…', 3000);
  try {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(new URL('../lib/draco/', location.href).href);
    draco.setDecoderConfig({ type: 'wasm' });
    loader.setDRACOLoader(draco);
    const url = new URL(L.cfg.file, BASE_URL).href;
    const buf = await fetchBuffer(url, () => {});
    const gltf = await loader.parseAsync(buf, BASE_URL.href);
    draco.dispose();
    L.deferred = false;
    L.loading = false;
    buildLabels(gltf);
    L.on = true;
    applyLabelsVisibility();
    updateInfoDynamic();
    toast('砌块标注已加载', 2200);
    return true;
  } catch (err) {
    L.loading = false;
    L.error = (err && err.message) ? err.message : String(err);
    console.warn('[viewer] 砌块标注加载失败（已忽略）', err);
    updateInfoDynamic();
    toast('标注资产未就绪，无法显示砌块标注');
    return false;
  }
}

function applyVisibility() {
  const anyCat = state.categories.some((c) => state.catVisible[c.code]);
  state.floorGroups.forEach((fg) => {
    const floorVisible = state.selectedFloor === 'all' || fg.key === state.selectedFloor;
    fg.group.visible = floorVisible && anyCat;
    fg.meshes.forEach((m) => {
      const on = !!state.catVisible[m.userData.code] &&
        (!m.userData.thickness || !!state.thicknessVisible[m.userData.thickness]);
      m.visible = on;
    });
  });
  if (state.grid) state.grid.visible = state.showGrid;
  applyLabelsVisibility();
  applyEdgesVisibility();
  applySelectionVisibility();
  updateFloorPanelState();
  updateCategoryPanelState();
  updateStatsBar();
  updateClipUI();
}

function updateFloorPanelState() {
  ui.floorList.querySelectorAll('.floor-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.key === state.selectedFloor ||
      (state.selectedFloor === 'all' && btn.dataset.key === 'all'));
  });
}

function updateCategoryPanelState() {
  ui.catList.querySelectorAll('.cat-item[data-code]').forEach((label) => {
    const code = label.dataset.code;
    label.classList.toggle('off', !state.catVisible[code]);
    const input = label.querySelector('input.switch');
    if (input) input.checked = !!state.catVisible[code];
  });
  ui.catList.querySelectorAll('.cat-item[data-thickness]').forEach((label) => {
    const code = label.dataset.thickness;
    const on = !!state.catVisible.QC && !!state.thicknessVisible[code];
    label.classList.toggle('off', !on);
    const input = label.querySelector('input.switch');
    if (input) input.checked = on;
  });
}

/* ---------------- 统计条 ---------------- */
/** 单层计数：respectFilter=true 时按当前类别/墙厚开关计算。
 *  Lead 的精确口径：counts = { QC:合计, T100:x, T200:y, ..., L:.., Z:.. }，
 *  T<数字> 即各墙厚子项（缺键按 0），QC 键不重复计入。 */
function floorCountSum(fg, respectFilter) {
  const tmap = thicknessMap();
  const counts = fg.counts;
  if (!counts) {
    let elements = 0;
    let blocks = 0;
    fg.meshes.forEach((m) => {
      if (respectFilter && !m.visible) return;
      elements += m.userData.elements;
      if (m.userData.code === 'QC') blocks += m.userData.elements;
    });
    return { elements, blocks };
  }
  const hasT = Object.keys(counts).some((k) => tmap.has(k.toUpperCase()));
  const hasQC = Object.prototype.hasOwnProperty.call(counts, 'QC');
  let elements = 0;
  let blocks = 0;
  let hiddenThick = 0;   // 被关掉的墙厚子项数量（从 QC 总数里扣）
  Object.entries(counts).forEach(([code, n]) => {
    const key = code.toUpperCase();
    const val = num(n);
    if (tmap.has(key)) {
      // 厚度子项：只是 QC 的子集，用于扣减，不单独累加
      if (respectFilter && !(state.catVisible.QC && state.thicknessVisible[code])) hiddenThick += val;
      return;
    }
    if (code === 'QC') return; // 砌块总数最后统一算
    if (respectFilter && !state.catVisible[code]) return;
    elements += val;
  });
  if (hasQC) {
    const qcTotal = num(counts.QC);
    if (!respectFilter || state.catVisible.QC) {
      const qcVisible = Math.max(0, qcTotal - (hasT ? hiddenThick : 0));
      elements += qcVisible;
      blocks += qcVisible;
    }
  } else if (hasT) {
    // 旧数据兜底：QC 不存在时按厚度子项累加
    Object.entries(counts).forEach(([code, n]) => {
      if (!tmap.has(code.toUpperCase())) return;
      if (respectFilter && !(state.catVisible.QC && state.thicknessVisible[code])) return;
      elements += num(n); blocks += num(n);
    });
  }
  return { elements, blocks };
}

function visibleSummary() {
  const floorKeys = [];
  let elements = 0;
  let blocks = 0;
  for (const fg of state.floorGroups) {
    if (state.selectedFloor !== 'all' && fg.key !== state.selectedFloor) continue;
    floorKeys.push(fg.key);
    const r = floorCountSum(fg, true);
    elements += r.elements;
    blocks += r.blocks;
  }
  return { floors: floorKeys, elements, blocks };
}

function manifestTotal() {
  const s = (state.manifest && state.manifest.stats) || {};
  let elements = 0;
  let blocks = 0;
  for (const fg of state.floorGroups) {
    const r = floorCountSum(fg, false);
    elements += r.elements;
    blocks += r.blocks;
  }
  return {
    blocks: Number.isFinite(Number(s.blocks)) ? Number(s.blocks) : blocks,
    elements: Number.isFinite(Number(s.elements)) ? Number(s.elements) : elements,
  };
}

function updateStatsBar() {
  const total = manifestTotal();
  const vis = visibleSummary();
  ui.statTotalBlocks.textContent = fmt(total.blocks);
  if (state.selectedFloor === 'all') {
    ui.statFloors.textContent = '全部 ' + state.floorGroups.length + ' 层';
  } else {
    const fg = state.floorGroups.find((f) => f.key === state.selectedFloor);
    ui.statFloors.textContent = fg ? (fg.label || fg.key) : state.selectedFloor;
  }
  ui.statElements.textContent = fmt(vis.elements);
  ui.statElements.title = '当前可见构件 ' + fmt(vis.elements) + ' / 总计 ' + fmt(total.elements) +
    '（其中可见砌块 ' + fmt(vis.blocks) + '）';
}

/* ---------------- 剖切 UI ---------------- */
function updateClipUI() {
  const box = state.bbox;
  const min = box.min.y;
  const max = box.max.y;
  ui.clipMin.textContent = min.toFixed(2) + ' m';
  ui.clipMax.textContent = max.toFixed(2) + ' m';
  ui.clipRange.min = String(min);
  ui.clipRange.max = String(max);
  ui.clipRange.step = String(Math.max(0.005, (max - min) / 400));
  const cur = state.clipEnabled ? state.clipY : max;
  ui.clipRange.value = String(cur);
  const pct = max > min ? ((cur - min) / (max - min)) * 100 : 100;
  ui.clipRange.style.setProperty('--p', pct.toFixed(1) + '%');
  ui.clipValue.classList.toggle('is-off', !state.clipEnabled);
  ui.clipValue.textContent = state.clipEnabled ? state.clipY.toFixed(2) + ' m' : '关闭';
  ui.clipState.textContent = state.clipEnabled ? '· 已剖切（保留下方）' : '';
  ui.btnClipOff.disabled = !state.clipEnabled;
  ui.btnClipOff.style.opacity = state.clipEnabled ? '1' : '.5';
}

/* ---------------- 模型信息 ---------------- */
function labelStateText() {
  const L = state.labels;
  if (!L.cfg) return '未配置';
  if (!L.loaded) {
    if (L.loading) return '加载中…';
    if (L.deferred) return '手机按需，点工具开启';
    return L.error ? '未就绪' : '加载中';
  }
  if (L.invalid) return '标注与模型坐标不一致，已跳过';
  if (window.innerWidth < 768) {
    return L.on ? '开（手动开启）' : '关（手机默认关，可在工具里手动开）';
  }
  return L.on ? '开' : '关';
}

function buildInfoPanel() {
  const m = state.manifest || {};
  const size = state.bbox.getSize(new THREE.Vector3());
  const total = manifestTotal();
  const rows = [
    ['平面尺寸', size.x.toFixed(2) + ' × ' + size.z.toFixed(2) + ' m'],
    ['竖向范围', state.bbox.min.y.toFixed(2) + ' ~ ' + state.bbox.max.y.toFixed(2) + ' m'],
    ['楼层 / 构件', state.floorGroups.length + ' 层 / ' + fmt(total.elements) + ' 件'],
    ['砌块合计', fmt(total.blocks) + ' 块'],
    ['几何量', '≈ ' + (state.triangles / 10000).toFixed(1) + ' 万面 · ' + state.meshCount + ' 批'],
    ['每块砌块标注', '<span id="infoLabels">' + labelStateText() + '</span>'],
    ['标注范围', state.labels.family ? ('仅 ' + state.labels.family) : '全部砌块'],
    ['砖边线 / 灰缝', '<span id="infoEdges">' + edgesStateText() + '</span>'],
    ['构件点选', '<span id="infoPick">' + pickStateText() + '</span>'],
    ['单位 / 朝向', (m.unit || 'm') + ' / ' + (m.up || 'Y') + '-up'],
  ];
  const rawKeys = { '每块砌块标注': 1, '砖边线 / 灰缝': 1, '构件点选': 1 };
  ui.infoList.innerHTML = rows.map((r) =>
    '<div><dt>' + esc(r[0]) + '</dt><dd>' + (rawKeys[r[0]] ? r[1] : esc(r[1])) + '</dd></div>').join('');
}

function edgesStateText() {
  const E = state.edges;
  if (!E.cfg) return '未配置';
  if (!E.loaded) return E.error ? '未就绪' : '加载中';
  return E.on ? '开' : '关';
}

function pickStateText() {
  const E = state.elements;
  if (E.ready) return '可用（单击构件）';
  return E.error ? '不可用（elements.json 未就绪）' : '加载中';
}

function updateInfoDynamic() {
  const el = $('infoLabels');
  if (el) el.textContent = labelStateText();
  const eel = $('infoEdges');
  if (eel) eel.textContent = edgesStateText();
  const pel = $('infoPick');
  if (pel) pel.textContent = pickStateText();
  if (ui.btnEdges) {
    const E = state.edges;
    const enabled = !!E.cfg;
    ui.btnEdges.disabled = !enabled;
    ui.btnEdges.style.opacity = enabled ? '1' : '.5';
    ui.btnEdges.setAttribute('aria-pressed', (E.on && E.loaded) ? 'true' : 'false');
    ui.btnEdges.title = !enabled ? '未配置砖边线层'
      : (!E.loaded ? (E.error ? '砖边线资产未就绪' : '砖边线加载中')
        : '显示 / 隐藏砌块边线与灰缝');
  }
  if (ui.btnLabels) {
    const L = state.labels;
    const enabled = !!L.cfg && !L.invalid;
    ui.btnLabels.disabled = !enabled;
    ui.btnLabels.style.opacity = enabled ? '1' : '.5';
    ui.btnLabels.setAttribute('aria-pressed', (L.on && L.loaded) ? 'true' : 'false');
    if (!L.cfg) ui.btnLabels.title = '未配置砌块标注';
    else if (L.invalid) ui.btnLabels.title = '标注与模型坐标不一致，已跳过（请检查 labels.glb）';
    else if (L.loading) ui.btnLabels.title = '标注正在加载…';
    else if (!L.loaded) {
      ui.btnLabels.title = L.deferred ? '手机端默认不加载标注（省显存），点击加载并显示'
        : (L.error ? '标注资产未就绪' : '标注加载中');
    } else {
      ui.btnLabels.title = (window.innerWidth < 768 && !L.on)
        ? '手机默认关闭标注（省显存），点击可开启'
        : '显示 / 隐藏每块砌块的长×厚×高';
    }
  }
}

/* ---------------- toast ---------------- */
let toastTimer = 0;
function toast(message, ms = 4200) {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), ms);
}

/* ============================================================
 * 八、收尾 / 自检 API
 * ============================================================ */
function finalize() {
  const loadedAny = state.floorGroups.length > 0;
  const t = state.loadMs;
  if (!loadedAny) {
    failLoader(state.errors.length
      ? '楼层 GLB 全部加载失败（资产可能未就绪）：' +
        state.errors.map((e) => e.key + ' ' + e.message).join('；')
      : '没有加载到任何楼层数据（assets/*.glb 是否已就位？）');
    return;
  }

  buildGround();
  applyViewport();
  frameModel(state.bbox, true);
  state.clipPlane.constant = state.bbox.max.y + 1e4;

  buildFloorPanel();
  buildCategoryPanel();
  buildClipControls();
  applyVisibility();
  updateClipUI();
  buildInfoPanel();
  updateInfoDynamic();
  if (window.innerWidth < 768) ui.panel.classList.add('is-collapsed');

  ui.loaderBar.style.width = '100%';
  ui.loaderPct.textContent = '100%';
  ui.loaderStatus.textContent = '加载完成 · 总计 ' + (t / 1000).toFixed(2) + ' s';
  window.setTimeout(() => ui.loader.classList.add('done'), 300);

  if (state.errors.length) {
    const bad = state.errors.map((e) => e.key).join(' / ');
    ui.statsbar.classList.add('has-warn');
    ui.chipWarn.textContent = '⚠ ' + bad + ' 加载失败';
    toast('部分楼层加载失败：' + bad + '，其余楼层已正常显示。');
  }
  if (state.labels.cfg && !state.labels.loaded && !state.labels.deferred) {
    console.warn('[viewer] 砌块标注未加载：', state.labels.error);
  }

  // 性能兜底：大模型在手机上提示按层查看，并进一步降低渲染分辨率
  if (window.innerWidth < 768 && state.triangles > 120000) {
    toast('模型较大（约 ' + Math.round(state.triangles / 10000) +
      ' 万三角面）：手机建议按层查看，逐层浏览更流畅。', 7000);
    if (state.triangles > 450000) {
      state.renderer.setPixelRatio(1);
      state.renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
  }

  if (ui.metaRight) {
    ui.metaRight.textContent = 'three.js r160 · 加载 ' + (t / 1000).toFixed(2) + 's' +
      ' · ' + state.meshCount + ' 批次';
  }

  state.ready = true;
  exposeAPI();
}

function failLoader(message) {
  ui.loader.classList.add('failed');
  ui.loaderPct.textContent = '—';
  ui.loaderStatus.textContent = message;
  ui.loaderStatus.classList.add('err');
  ui.loaderBar.style.width = '100%';
  console.error('[viewer]', message);
}

function buildClipControls() {
  ui.clipRange.addEventListener('input', () => {
    const v = Number(ui.clipRange.value);
    const max = state.bbox.max.y;
    if (max - v < Math.max(0.01, (max - state.bbox.min.y) / 600)) setClip(null);
    else setClip(v);
  });
  ui.btnClipOff.addEventListener('click', () => setClip(null));
}

function bindButtons() {
  ui.btnReset.addEventListener('click', resetView);
  ui.btnResetTop.addEventListener('click', resetView);
  ui.btnShowAll.addEventListener('click', () => setShowAllFloors());
  ui.btnGrid.addEventListener('click', () => setGrid());
  ui.btnLabels.addEventListener('click', () => setLabels());
  if (ui.btnNear) ui.btnNear.addEventListener('click', () => flyToLabelView());
  if (ui.icHide) ui.icHide.addEventListener('click', () => hideSelectedElement());
  ui.btnEdges.addEventListener('click', () => setEdges());
  ui.loaderRetry.addEventListener('click', () => location.reload());
  if (ui.icClose) ui.icClose.addEventListener('click', () => clearSelection());
  if (ui.icCopy) ui.icCopy.addEventListener('click', () => copySelection());

  // 点选：pointerup 时位移小、时间短才算点击（避免旋转/平移后误选）
  const canvas = state.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    state.pick.downX = e.clientX;
    state.pick.downY = e.clientY;
    state.pick.downTime = performance.now();
    state.pick.dragging = false;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - state.pick.downX, e.clientY - state.pick.downY) > 6) {
      state.pick.dragging = true;
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const dt = performance.now() - state.pick.downTime;
    const dist = Math.hypot(e.clientX - state.pick.downX, e.clientY - state.pick.downY);
    if (dist <= 6 && dt <= 800) {
      pickAt(e.clientX, e.clientY);
    }
  });

  const toggleSheet = () => {
    if (window.innerWidth >= 768) return;
    state.sheetTouched = true;
    ui.panel.classList.toggle('is-collapsed');
  };
  ui.sheetHandle.addEventListener('click', toggleSheet);
  ui.sheetHandle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSheet(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setFloor('all'); setClip(null); clearSelection(); }
  });
}

function stats() {
  const vis = visibleSummary();
  const total = manifestTotal();
  const cam = state.camera;
  const labelNodes = state.labels.nodesByFloor || {};
  return {
    ready: state.ready,
    floors: state.floorGroups.length,
    floor: state.selectedFloor,
    visibleFloors: vis.floors,
    visibleElements: vis.elements,
    visibleBlocks: vis.blocks,
    totalElements: total.elements,
    totalBlocks: total.blocks,
    bbox: {
      min: state.bbox.min.toArray().map((v) => Number(v.toFixed(3))),
      max: state.bbox.max.toArray().map((v) => Number(v.toFixed(3))),
    },
    bboxWorld: state.bboxRaw ? {
      min: state.bboxRaw.min.toArray().map((v) => Number(v.toFixed(3))),
      max: state.bboxRaw.max.toArray().map((v) => Number(v.toFixed(3))),
    } : null,
    worldShift: { x: Number(state.worldShift.x.toFixed(3)), z: Number(state.worldShift.z.toFixed(3)) },
    categories: state.categories.map((c) => ({
      code: c.code, label: c.label, color: c.color, visible: !!state.catVisible[c.code],
    })),
    thickness: state.thicknessGroups.map((g) => ({
      code: g.code, label: g.label, thickness: g.thickness, color: g.color,
      count: g.count, visible: !!state.thicknessVisible[g.code],
    })),
    labels: {
      configured: !!state.labels.cfg,
      loaded: state.labels.loaded,
      loading: state.labels.loading,
      deferred: state.labels.deferred,
      on: state.labels.on,
      near: state.labels.near,
      lodDistance: state.labels.cfg ? Number(state.labels.cfg.lodDistance) || 16 : null,
      nodes: Object.keys(labelNodes),
      visibleNodes: Object.entries(labelNodes)
        .filter(([, node]) => node.visible).map(([k]) => k),
      error: state.labels.error,
      invalid: state.labels.invalid,
      bounds: state.labels.bounds,
      filter: state.labels.filter,
      family: state.labels.family || '',
    },
    edges: {
      configured: !!state.edges.cfg,
      loaded: state.edges.loaded,
      on: state.edges.on,
      error: state.edges.error,
      nodes: Object.keys(state.edges.nodesByFloor || {}),
      visibleNodes: Object.entries(state.edges.nodesByFloor || {})
        .filter(([, node]) => node.visible).map(([k]) => k),
    },
    elements: {
      ready: state.elements.ready,
      count: state.elements.count,
      error: state.elements.error,
      gridCells: state.elements.grid ? state.elements.grid.size : 0,
    },
    selection: getSelection(),
    clip: state.clipEnabled ? Number(state.clipY.toFixed(3)) : null,
    clipEnabled: state.clipEnabled,
    clipBounds: [Number(state.bbox.min.y.toFixed(3)), Number(state.bbox.max.y.toFixed(3))],
    loadedNodes: state.loadedNodes,
    meshes: state.meshCount,
    triangles: Math.round(state.triangles),
    errors: state.errors.map((e) => e.key),
    loadMs: Math.round(state.loadMs),
    camera: cam ? {
      position: cam.position.toArray().map((v) => Number(v.toFixed(2))),
      target: state.controls ? state.controls.target.toArray().map((v) => Number(v.toFixed(2))) : null,
    } : null,
    render: state.renderer ? {
      calls: state.renderer.info.render.calls,
      triangles: state.renderer.info.render.triangles,
    } : null,
  };
}

function exposeAPI() {
  window.__viewer = {
    scene: state.scene,
    camera: state.camera,
    controls: state.controls,
    model: state.model,
    manifest: state.manifest,
    labelsRoot: state.labels.root,
    edgesRoot: state.edges.root,
    setFloor,
    setShowAllFloors,
    toggleCategory,
    toggleThickness,
    setClip,
    setGrid,
    setLabels,
    setEdges,
    resetView,
    pickAt,
    selectElement,
    clearSelection,
  selectByRevitId,
    getSelection,
    stats,
  };
  window.__viewerReady = true;
}

/* ============================================================
 * 九、启动
 * ============================================================ */
async function boot() {
  buildDOM();
  initThree();
  bindButtons();

  const t0 = performance.now();
  state.loadStart = t0;
  try {
    await loadAssetVersion();
  watchAssetVersion();
  state.manifest = await fetchManifest();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    failLoader('无法读取 model.json（' + msg + '）：请确认 model.json 已就位，' +
      '并通过本地静态服务器打开本页。');
    return;
  }
  applyManifest();
  if (!state.floors.length) {
    failLoader('model.json 中没有任何楼层（floors 为空）');
    return;
  }

  const { floorResults, labelGltf, edgeGltf, elementsJson } = await loadAssets();
  state.loadMs = performance.now() - t0;
  buildModel(floorResults);
  buildLabels(labelGltf);
  buildEdges(edgeGltf);
  buildElements(elementsJson);
  finalize();
  // 深链接：?floor=<楼层key> 打开即只显示该层
  try {
    const wantFloor = new URLSearchParams(location.search).get('floor');
    if (wantFloor) {
      const f = state.floors.find((x) => String(x.key).toUpperCase() === wantFloor.toUpperCase());
      if (f) setFloor(f.key);
    }
  } catch (e) { /* ignore */ }
  // 深链接：?el=<RevitID> 打开即自动选中该构件（便于把链接发给别人核对）
  try {
    const wantEl = new URLSearchParams(location.search).get('el');
    if (wantEl) {
      const picked = selectByRevitId(wantEl);
      if (!picked) console.warn('[viewer] 未找到元素 ' + wantEl + '（可能不在当前模型/已删除）');
    }
  } catch (e) { /* ignore */ }
  // 调试钩子：?debug=mat 时把门/窗材质参数写到 title，便于无头浏览器核对
  try {
    if (new URLSearchParams(location.search).get('debug') === 'mat') {
      const info = [];
      state.model.traverse((o) => {
        if (o.isMesh && o.material && /(^|_)mat_(M|W)(_|$)/.test(o.material.name || '')) {
          info.push({ n: o.material.name, transparent: o.material.transparent,
            opacity: o.material.opacity, depthWrite: o.material.depthWrite, visible: o.visible });
        }
      });
      document.title = 'MATDBG ' + JSON.stringify(info.slice(0, 6));
    }
  } catch (e) { /* ignore */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { boot(); });
} else {
  boot();
}

import { BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

async function loadSystemFontFamilies(): Promise<string[]> {
  try {
    const mod = await import('font-list')
    const getFonts = (mod as unknown as { getFonts?: () => Promise<string[]> }).getFonts
    if (!getFonts) return []
    const fonts = await getFonts()
    return [...new Set(fonts.map((x) => String(x || '').trim()).filter(Boolean))]
  } catch {
    return []
  }
}

export async function openStreamPreviewWindow(input: {
  videoFramePath: string
  overlayFramePath?: string | null
  initialLayoutJson?: string | null
  onSave?: (layoutJson: string) => void
  onRenderMinute?: (
    layoutJson: string,
    onProgress?: (p: { elapsedSec: number; totalSec: number; remainingSec: number; percent: number }) => void
  ) => Promise<string>
}): Promise<void> {
  const videoUrl = pathToFileURL(input.videoFramePath).toString()
  const overlayUrl = input.overlayFramePath ? pathToFileURL(input.overlayFramePath).toString() : ''
  const initialLayoutEncoded = encodeURIComponent(input.initialLayoutJson ?? '')
  const mainFonts = await loadSystemFontFamilies()
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Предпросмотр стрима</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; background: #0f1115; color: #d8dde5; font-family: Segoe UI, Arial, sans-serif; }
      .wrap { display: grid; grid-template-columns: 300px 1fr; height: 100vh; }
      .left { border-right: 1px solid #2a2f37; display: grid; grid-template-rows: auto 1fr auto; min-width: 0; background: #141922; }
      .head { padding: 10px; border-bottom: 1px solid #2a2f37; display: grid; gap: 8px; }
      .title { font-size: 14px; font-weight: 600; }
      .row { display: grid; gap: 6px; }
      .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      label { font-size: 12px; color: #a3acb9; }
      input, select, textarea { background: #131821; color: #d8dde5; border: 1px solid #2a2f37; border-radius: 4px; padding: 6px; font-size: 12px; }
      button { background: #131821; color: #d8dde5; border: 1px solid #2a2f37; border-radius: 4px; padding: 6px; font-size: 12px; cursor: pointer; }
      button:hover { border-color: #4f5b6d; }
      .btn-green { border-color: #2e7d58; background: #123626; color: #9ef3cc; }
      .btn-green:hover { border-color: #37c18a; }
      .btn-red { border-color: #7c2a2a; color: #ffb5b5; }
      .sources { overflow: auto; padding: 8px; }
      .srcRow {
        display: grid; grid-template-columns: auto 1fr auto auto; align-items: center;
        gap: 6px; padding: 6px; border: 1px solid #2a2f37; border-radius: 5px; margin-bottom: 6px; background: #101520;
      }
      .srcRow.sel { border-color: #37c18a; box-shadow: 0 0 0 1px #37c18a inset; }
      .srcRow.dragging { opacity: 0.55; }
      .srcName { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .chip { font-size: 10px; color: #9aa6b7; border: 1px solid #2a2f37; border-radius: 3px; padding: 1px 4px; }
      .mini { font-size: 11px; padding: 2px 6px; }
      .dragHandle { color: #8fa0b8; cursor: grab; user-select: none; padding: 0 3px; }
      .foot { border-top: 1px solid #2a2f37; padding: 8px; display: grid; gap: 8px; }
      .stageWrap { display: grid; place-items: center; align-content: center; gap: 10px; padding: 12px; overflow: auto; }
      .stage { position: relative; width: 360px; height: 640px; background: #000; border: 1px solid #2a2f37; overflow: hidden; }
      .renderBtn { border-color: #2a5e8a; background: #10273a; color: #a6d7ff; padding: 8px 12px; }
      .renderBtn:hover { border-color: #4f9ddd; }
      .guide { position: absolute; pointer-events: none; opacity: 0; z-index: 9999; }
      .guide.on { opacity: 0.9; }
      .guide.v { top: 0; bottom: 0; width: 1px; background: rgba(55,193,138,0.85); left: 50%; }
      .guide.h { left: 0; right: 0; height: 1px; background: rgba(55,193,138,0.85); top: 50%; }
      .layer { position: absolute; overflow: hidden; border: 1px dashed #4f5b6d; min-width: 40px; min-height: 24px; box-sizing: border-box; }
      .layer.active { border-color: #37c18a; box-shadow: 0 0 0 1px #37c18a inset; }
      .layer img { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; pointer-events: none; }
      .textLayer { position: absolute; min-width: 80px; min-height: 24px; padding: 4px 8px; cursor: move; white-space: pre-wrap; }
      .textLayer.active { outline: 1px dashed #37c18a; }
      .muted { color: #8a93a1; font-size: 11px; }
      .editor { position: fixed; inset: 0; display: none; z-index: 10000; pointer-events: none; }
      .editor.on { display: block; }
      .editorCard {
        position: absolute;
        left: 320px;
        top: 20px;
        width: min(560px, calc(100vw - 360px));
        max-height: calc(100vh - 40px);
        overflow: auto;
        background: #141922;
        border: 1px solid #2a2f37;
        border-radius: 8px;
        padding: 12px;
        display: grid;
        gap: 10px;
        pointer-events: auto;
      }
      .editorTitle { font-size: 14px; font-weight: 600; cursor: move; user-select: none; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="left">
        <div class="head">
          <div class="title">Источники</div>
          <div class="row">
            <label>Масштаб предпросмотра: <span id="previewScaleVal">100%</span></label>
            <input id="previewScale" type="range" min="40" max="170" step="1" value="100" />
          </div>
          <div class="row2">
            <button id="addTextBtn" type="button">+ Текст</button>
            <button id="addMediaBtn" type="button">+ Картинка/GIF</button>
          </div>
          <div class="row2">
            <button id="removeSourceBtn" class="btn-red" type="button">Удалить источник</button>
            <button id="saveLayoutBtn" class="btn-green" type="button">Сохранить</button>
          </div>
        </div>
        <div class="sources" id="sourcesList"></div>
        <div class="foot">
          <p class="muted">Перетаскивай источники слева мышкой, чтобы менять слой. Двойной клик открывает параметры только у новых элементов.</p>
        </div>
      </div>
      <div class="stageWrap">
        <div class="stage" id="stage">
          <div id="guideV" class="guide v"></div>
          <div id="guideH" class="guide h"></div>
        </div>
        <button id="renderMinuteBtn" class="renderBtn" type="button">Сделать рендер 1 минуты стрима</button>
      </div>
    </div>
    <input id="addMediaInput" type="file" accept="image/*,.gif" style="display:none" />
    <input id="replaceMediaInput" type="file" accept="image/*,.gif" style="display:none" />
    <div id="srcEditor" class="editor">
      <div class="editorCard">
        <div class="editorTitle" id="editorTitle">Редактор источника</div>
        <div id="editorBody"></div>
        <div class="row">
          <button id="editorCloseBtn" type="button">Закрыть</button>
        </div>
      </div>
    </div>
    <script>
      const initialLayout = (() => {
        try {
          const raw = ${JSON.stringify(initialLayoutEncoded)}
          if (!raw) return null
          const decoded = decodeURIComponent(raw)
          return decoded || null
        } catch {
          return null
        }
      })()
      const stage = document.getElementById('stage')
      const previewScale = document.getElementById('previewScale')
      const previewScaleVal = document.getElementById('previewScaleVal')
      const sourcesList = document.getElementById('sourcesList')
      const guideV = document.getElementById('guideV')
      const guideH = document.getElementById('guideH')
      const addTextBtn = document.getElementById('addTextBtn')
      const addMediaBtn = document.getElementById('addMediaBtn')
      const addMediaInput = document.getElementById('addMediaInput')
      const replaceMediaInput = document.getElementById('replaceMediaInput')
      const removeSourceBtn = document.getElementById('removeSourceBtn')
      const saveLayoutBtn = document.getElementById('saveLayoutBtn')
      const renderMinuteBtn = document.getElementById('renderMinuteBtn')
      const srcEditor = document.getElementById('srcEditor')
      const editorCard = srcEditor.querySelector('.editorCard')
      const editorTitle = document.getElementById('editorTitle')
      const editorBody = document.getElementById('editorBody')
      const editorCloseBtn = document.getElementById('editorCloseBtn')

      let selectedId = null
      let editingId = null
      let replacingSourceId = null
      let draggingSourceId = null
      let sourceIdSeq = 1000
      const STANDARD_TEXT_FONT = 'Arial'
      let systemFonts = ${JSON.stringify(mainFonts.length ? mainFonts : ['Segoe UI', 'Arial', 'Tahoma', 'Verdana', 'Times New Roman'])}
      const sources = []

      function decodeFileUrlToFsPath(raw) {
        const v = String(raw || '').trim()
        if (!/^file:\\/\\//i.test(v)) return ''
        try {
          const u = new URL(v)
          if (!u || u.protocol !== 'file:') return ''
          const p = decodeURIComponent(u.pathname || '')
          if (/^\\/[A-Za-z]:\\//.test(p)) return p.slice(1).split('/').join(String.fromCharCode(92))
          return p || ''
        } catch {
          return ''
        }
      }

      function normalizeSourceLoadedFromPreset(src) {
        if (!src || typeof src !== 'object') return src
        const isMedia =
          src.type === 'image' ||
          src.type === 'gif' ||
          src.type === 'video' ||
          src.type === 'overlay'
        if (!isMedia) return src
        const filePathRaw = String(src.filePath || '').trim()
        const srcRaw = String(src.src || '').trim()
        const decodedFromFileUrl = decodeFileUrlToFsPath(srcRaw)
        if (!filePathRaw && decodedFromFileUrl) {
          src.filePath = decodedFromFileUrl
        }
        if (!srcRaw && filePathRaw) {
          src.src = filePathRaw
        }
        return src
      }

      function mkId(prefix) {
        sourceIdSeq += 1
        return prefix + '-' + sourceIdSeq
      }

      function applyPreviewScale() {
        const s = Math.max(40, Number(previewScale.value || 100))
        stage.style.zoom = String(s / 100)
        previewScaleVal.textContent = s + '%'
      }

      function queryLayerEl(id) {
        return stage.querySelector('[data-source-id="' + id + '"]')
      }

      function sourceDisplayName(s) {
        if (s.type === 'video') return 'Видео'
        if (s.type === 'overlay') return 'Оверлей'
        if (s.type === 'image') return s.name || 'Картинка'
        if (s.type === 'gif') return s.name || 'GIF'
        return s.name || 'Текст'
      }

      function fitByAspect(src, iw, ih) {
        if (!(iw > 0 && ih > 0)) return
        const maxW = stage.clientWidth || 360
        const maxH = stage.clientHeight || 640
        const k = Math.min(maxW / iw, maxH / ih)
        src.w = Math.max(40, Math.round(iw * k))
        src.h = Math.max(24, Math.round(ih * k))
      }

      function buildTextShadow(t) {
        const s = Math.max(0, Number(t.strokeSize || 0))
        const c = t.strokeColor || '#000000'
        const shadow = []
        for (let x = -s; x <= s; x++) {
          for (let y = -s; y <= s; y++) {
            if (x || y) shadow.push(x + 'px ' + y + 'px 0 ' + c)
          }
        }
        return shadow.join(',')
      }

      function applyLayerOrder() {
        for (const s of sources) {
          const el = queryLayerEl(s.id)
          if (!el) continue
          el.style.zIndex = String(Number(s.z || 1))
        }
      }

      function initSources() {
        const ensureCoreSources = () => {
          const hasVideo = sources.some((s) => s && s.type === 'video')
          const hasOverlay = sources.some((s) => s && s.type === 'overlay')
          if (!hasVideo) {
            sources.push({
              id: 'video-root',
              type: 'video',
              name: 'Видео',
              locked: true,
              visible: true,
              z: 10,
              x: 0,
              y: 0,
              w: 360,
              h: 640,
              src: ${JSON.stringify(videoUrl)}
            })
          }
          if (${overlayUrl ? 'true' : 'false'} && !hasOverlay) {
            sources.push({
              id: 'overlay-root',
              type: 'overlay',
              name: 'Оверлей',
              locked: true,
              visible: true,
              z: 20,
              x: 12,
              y: 12,
              w: 336,
              h: 616,
              src: ${JSON.stringify(overlayUrl)}
            })
          }
        }
        let j = null
        try { j = initialLayout ? JSON.parse(initialLayout) : null } catch { j = null }
        if (j && typeof j === 'object') {
          if (typeof j.previewScale === 'number') {
            previewScale.value = String(j.previewScale)
            applyPreviewScale()
          }
          if (Array.isArray(j.sources) && j.sources.length > 0) {
            for (const src of j.sources) {
              if (!src || typeof src !== 'object') continue
              sources.push(normalizeSourceLoadedFromPreset(src))
            }
            ensureCoreSources()
            if (sources.length > 0) {
              selectedId = sources[0]?.id || null
              return
            }
          }
        }
        ensureCoreSources()
        sources.push({
          id: mkId('text'),
          type: 'text',
          name: 'Текст',
          locked: false,
          visible: true,
          z: 30,
          x: 40,
          y: 40,
          w: 320,
          h: 80,
          text: {
            content: 'Текст поверх стрима',
            font: 'Arial',
            fontFilePath: null,
            size: 42,
            color: '#ffffff',
            strokeColor: '#000000',
            strokeSize: 2,
            visible: true
          }
        })
        selectedId = sources[0]?.id || null
      }

      function serializeLayout() {
        const outSources = sources.map((s) => ({
          ...s,
          id: s.id,
          type: s.type,
          name: s.name,
          locked: !!s.locked,
          visible: s.visible !== false,
          z: Number(s.z || 1),
          x: Number(s.x || 0),
          y: Number(s.y || 0),
          w: Number(s.w || 100),
          h: Number(s.h || 100),
          src: s.src || null,
          filePath: s.filePath || decodeFileUrlToFsPath(s.src) || null,
          text: s.text || null
        }))
        return {
          previewScale: Number(previewScale.value || 100),
          sources: outSources
        }
      }

      function renderSourcesList() {
        sourcesList.innerHTML = ''
        const sorted = [...sources].sort((a, b) => Number(b.z || 0) - Number(a.z || 0))
        for (const s of sorted) {
          const row = document.createElement('div')
          row.className = 'srcRow' + (selectedId === s.id ? ' sel' : '')
          row.dataset.id = s.id
          row.draggable = true
          row.innerHTML = '<span class="dragHandle">☰</span><div class="srcName"></div><button class="mini visBtn" type="button"></button><span class="chip lockChip"></span>'
          row.querySelector('.srcName').textContent = sourceDisplayName(s)
          row.querySelector('.visBtn').textContent = s.visible === false ? '○' : '●'
          row.querySelector('.lockChip').textContent = s.locked ? '🔒' : ''
          row.addEventListener('click', () => { selectedId = s.id; renderAll() })
          row.querySelector('.visBtn').addEventListener('click', (e) => {
            e.stopPropagation()
            s.visible = s.visible === false ? true : false
            renderAll()
          })
          row.addEventListener('dragstart', (e) => {
            draggingSourceId = s.id
            row.classList.add('dragging')
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', s.id)
            }
          })
          row.addEventListener('dragend', () => {
            row.classList.remove('dragging')
            draggingSourceId = null
          })
          row.addEventListener('dragover', (e) => {
            if (!draggingSourceId || draggingSourceId === s.id) return
            e.preventDefault()
          })
          row.addEventListener('drop', (e) => {
            if (!draggingSourceId || draggingSourceId === s.id) return
            e.preventDefault()
            reorderSourcesByDrop(draggingSourceId, s.id)
            draggingSourceId = null
            renderAll()
          })
          row.addEventListener('dblclick', () => {
            if (s.locked) return
            openEditorForSource(s.id)
          })
          sourcesList.appendChild(row)
        }
      }

      function toRenderableMediaSrc(raw) {
        const v = String(raw || '').trim()
        if (!v) return ''
        if (
          v.startsWith('data:') ||
          v.startsWith('blob:') ||
          v.startsWith('http://') ||
          v.startsWith('https://') ||
          v.startsWith('file://')
        ) {
          return v
        }
        const winAbs = /^[A-Za-z]:[\\/]/.test(v)
        if (winAbs) {
          const p = v.split(String.fromCharCode(92)).join('/')
          return 'file:///' + encodeURI(p)
        }
        if (v.startsWith('/')) return 'file://' + encodeURI(v)
        return v
      }

      function reorderSourcesByDrop(dragId, targetId) {
        const order = [...sources].sort((a, b) => Number(b.z || 0) - Number(a.z || 0))
        const from = order.findIndex((x) => x.id === dragId)
        const to = order.findIndex((x) => x.id === targetId)
        if (from < 0 || to < 0) return
        const [item] = order.splice(from, 1)
        order.splice(to, 0, item)
        const topZ = 1000
        for (let i = 0; i < order.length; i += 1) {
          order[i].z = topZ - i
        }
      }

      function renderStage() {
        const keep = new Set(['guideV', 'guideH'])
        for (const n of [...stage.children]) {
          if (!keep.has(n.id)) stage.removeChild(n)
        }
        for (const s of sources) {
          const isText = s.type === 'text'
          const el = document.createElement('div')
          el.className = isText ? 'textLayer layer' : 'layer'
          el.dataset.sourceId = s.id
          el.style.left = String(Number(s.x || 0)) + 'px'
          el.style.top = String(Number(s.y || 0)) + 'px'
          el.style.width = String(Math.max(40, Number(s.w || 100))) + 'px'
          el.style.height = String(Math.max(24, Number(s.h || 100))) + 'px'
          el.style.display = s.visible === false ? 'none' : 'block'
          if (selectedId === s.id) el.classList.add('active')
          if (isText) {
            const t = s.text || {}
            el.textContent = t.content || ''
            el.style.fontFamily = STANDARD_TEXT_FONT
            el.style.fontSize = String(Number(t.size || 42)) + 'px'
            el.style.color = t.color || '#ffffff'
            el.style.textShadow = buildTextShadow({ strokeColor: t.strokeColor || '#000000', strokeSize: Number(t.strokeSize || 2) })
            if (t.visible === false) el.style.display = 'none'
          } else {
            const img = document.createElement('img')
            img.src = toRenderableMediaSrc(s.src || '')
            img.addEventListener('load', () => {
              if ((s.type === 'video' || s.type === 'overlay') && !s._aspectInited) {
                s._aspectInited = true
                fitByAspect(s, img.naturalWidth, img.naturalHeight)
                renderAll()
              }
            }, { once: true })
            el.appendChild(img)
          }
          stage.appendChild(el)
          makeDraggable(el, 'active', s.id)
        }
        applyLayerOrder()
      }

      function renderAll() {
        renderSourcesList()
        renderStage()
      }

      function makeDraggable(el, activeClass, sourceId) {
        let sx = 0, sy = 0, ox = 0, oy = 0
        let isResizing = false
        let resizeEdge = ''
        let startW = 0, startH = 0, startX = 0, startY = 0
        const SNAP_PX = 8
        const EDGE_PX = 8
        const src = () => sources.find((x) => x.id === sourceId)
        const detectEdge = (e) => {
          const r = el.getBoundingClientRect()
          const x = e.clientX - r.left
          const y = e.clientY - r.top
          const left = x <= EDGE_PX
          const right = x >= r.width - EDGE_PX
          const top = y <= EDGE_PX
          const bottom = y >= r.height - EDGE_PX
          const h = left ? 'l' : right ? 'r' : ''
          const v = top ? 't' : bottom ? 'b' : ''
          return h + v
        }
        const syncCursor = (edge) => {
          if (!edge) { el.style.cursor = sourceId.startsWith('text-') ? 'move' : 'grab'; return }
          if (edge === 'l' || edge === 'r') el.style.cursor = 'ew-resize'
          else if (edge === 't' || edge === 'b') el.style.cursor = 'ns-resize'
          else if (edge === 'lt' || edge === 'rb') el.style.cursor = 'nwse-resize'
          else el.style.cursor = 'nesw-resize'
        }
        el.addEventListener('pointermove', (e) => {
          if (isResizing) return
          syncCursor(detectEdge(e))
        })
        const moveHandler = (e) => {
          if (isResizing) {
            const s = src()
            if (!s) return
            let dx = e.clientX - sx
            let dy = e.clientY - sy
            let nx = startX
            let ny = startY
            let nw = startW
            let nh = startH
            const byWidth = () => {
              if (resizeEdge.includes('r')) nw = Math.max(40, startW + dx)
              if (resizeEdge.includes('l')) {
                nw = Math.max(40, startW - dx)
                nx = startX + (startW - nw)
              }
            }
            const byHeight = () => {
              if (resizeEdge.includes('b')) nh = Math.max(24, startH + dy)
              if (resizeEdge.includes('t')) {
                nh = Math.max(24, startH - dy)
                ny = startY + (startH - nh)
              }
            }
            if (e.shiftKey) {
              if (resizeEdge === 'l' || resizeEdge === 'r') {
                byWidth()
              } else if (resizeEdge === 't' || resizeEdge === 'b') {
                byHeight()
              } else {
                if (Math.abs(dx) >= Math.abs(dy)) byWidth()
                else byHeight()
              }
            } else {
              byWidth()
              byHeight()
              const ar = Math.max(0.01, startW / Math.max(1, startH))
              if (resizeEdge === 'l' || resizeEdge === 'r') {
                nh = Math.max(24, Math.round(nw / ar))
              } else if (resizeEdge === 't' || resizeEdge === 'b') {
                nw = Math.max(40, Math.round(nh * ar))
              } else {
                const byW = Math.max(24, Math.round(nw / ar))
                const byH = Math.max(40, Math.round(nh * ar))
                if (Math.abs(byW - nh) < Math.abs(byH - nw)) nh = byW
                else nw = byH
              }
            }
            el.style.left = nx + 'px'
            el.style.top = ny + 'px'
            el.style.width = nw + 'px'
            el.style.height = nh + 'px'
            s.x = Math.round(nx)
            s.y = Math.round(ny)
            s.w = Math.round(nw)
            s.h = Math.round(nh)
            return
          }
          let nx = ox + (e.clientX - sx)
          let ny = oy + (e.clientY - sy)
          const stageRect = stage.getBoundingClientRect()
          const w = el.offsetWidth || 0
          const h = el.offsetHeight || 0
          const centerStageX = stageRect.width / 2
          const centerStageY = stageRect.height / 2
          const centerElX = nx + w / 2
          const centerElY = ny + h / 2
          let snappedX = false
          let snappedY = false
          if (Math.abs(centerElX - centerStageX) <= SNAP_PX) {
            nx = centerStageX - w / 2
            snappedX = true
          }
          if (Math.abs(centerElY - centerStageY) <= SNAP_PX) {
            ny = centerStageY - h / 2
            snappedY = true
          }
          el.style.left = nx + 'px'
          el.style.top = ny + 'px'
          const s = src()
          if (s) {
            s.x = Math.round(nx)
            s.y = Math.round(ny)
          }
          guideV.classList.toggle('on', snappedX)
          guideH.classList.toggle('on', snappedY)
        }
        const upHandler = () => {
          window.removeEventListener('pointermove', moveHandler)
          window.removeEventListener('pointerup', upHandler)
          isResizing = false
          resizeEdge = ''
          el.classList.remove(activeClass)
          guideV.classList.remove('on')
          guideH.classList.remove('on')
          const s = src()
          if (s) {
            s.w = Math.max(40, el.offsetWidth || s.w || 100)
            s.h = Math.max(24, el.offsetHeight || s.h || 100)
          }
        }
        el.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return
          selectedId = sourceId
          renderSourcesList()
          resizeEdge = detectEdge(e)
          isResizing = Boolean(resizeEdge)
          sx = e.clientX; sy = e.clientY
          const r = el.getBoundingClientRect()
          const p = el.offsetParent.getBoundingClientRect()
          ox = r.left - p.left; oy = r.top - p.top
          startX = ox
          startY = oy
          startW = el.offsetWidth || 100
          startH = el.offsetHeight || 100
          el.classList.add(activeClass)
          window.addEventListener('pointermove', moveHandler)
          window.addEventListener('pointerup', upHandler)
          e.preventDefault()
        })
      }

      function fontsOptionsHtml(value) {
        const unique = [...new Set(systemFonts)].sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }))
        const current = (value || '').replaceAll('"', '&quot;')
        const opts = unique.map((f) => '<option value="' + f.replaceAll('"', '&quot;') + '">' + f + '</option>').join('')
        return '' +
          '<input id="edFontInput" type="hidden" value="' + current + '" />' +
          '<input id="edFontSearch" placeholder="Поиск шрифта..." value="' + current + '" />' +
          '<select id="edFontSelect" size="10" style="max-height:220px;overflow:auto;">' + opts + '</select>'
      }

      function wireFontSelector() {
        const search = document.getElementById('edFontSearch')
        const select = document.getElementById('edFontSelect')
        const hidden = document.getElementById('edFontInput')
        if (!search || !select || !hidden) return
        const all = [...new Set(systemFonts)].sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }))
        const render = (q) => {
          const qn = String(q || '').trim().toLowerCase()
          const list = qn ? all.filter((f) => f.toLowerCase().includes(qn)) : all
          select.innerHTML = list
            .map((f) => '<option value="' + f.replaceAll('"', '&quot;') + '">' + f + '</option>')
            .join('')
          const v = hidden.value || search.value || ''
          const match = [...select.options].find((o) => o.value === v)
          if (match) match.selected = true
        }
        render(search.value)
        search.addEventListener('input', () => {
          hidden.value = search.value
          render(search.value)
          applyEditorChangesLive()
        })
        select.addEventListener('change', () => {
          const v = select.value || ''
          hidden.value = v
          search.value = v
          applyEditorChangesLive()
        })
        select.addEventListener('dblclick', () => {
          const v = select.value || ''
          hidden.value = v
          search.value = v
          applyEditorChangesLive()
        })
      }

      function openEditorForSource(id) {
        const s = sources.find((x) => x.id === id)
        if (!s || s.locked) return
        editingId = id
        editorTitle.textContent = 'Редактор: ' + sourceDisplayName(s)
        if (s.type === 'text') {
          const t = s.text || {}
          editorBody.innerHTML =
            '<div class="row"><label>Имя источника</label><input id="edName" value="' + (s.name || '').replaceAll('"', '&quot;') + '" /></div>' +
            '<div class="row"><label>Текст</label><textarea id="edText" rows="4">' + (t.content || '') + '</textarea></div>' +
            '<div class="row"><label>Шрифт</label><input value="' + STANDARD_TEXT_FONT + '" readonly /></div>' +
            '<div class="row2"><label>Размер<input id="edSize" type="number" min="10" max="240" value="' + Number(t.size || 42) + '" /></label><label>Толщина обводки<input id="edStrokeSize" type="number" min="0" max="16" value="' + Number(t.strokeSize || 2) + '" /></label></div>' +
            '<div class="row2"><label>Цвет текста<input id="edColor" type="color" value="' + (t.color || '#ffffff') + '" /></label><label>Цвет обводки<input id="edStrokeColor" type="color" value="' + (t.strokeColor || '#000000') + '" /></label></div>' +
            '<div class="row"><label><input id="edVisible" type="checkbox" ' + ((s.visible === false || t.visible === false) ? '' : 'checked') + ' /> Показывать</label></div>'
        } else {
          const shownPath =
            (s.filePath && String(s.filePath).trim()) ||
            decodeFileUrlToFsPath(s.src || '') ||
            (/^(data:|blob:|https?:|file:\\/\\/)/i.test(String(s.src || '')) ? '' : String(s.src || '').trim())
          editorBody.innerHTML =
            '<div class="row"><label>Имя источника</label><input id="edName" value="' + (s.name || '').replaceAll('"', '&quot;') + '" /></div>' +
            '<div class="row"><label>Путь файла</label><input id="edFilePath" value="' + String(shownPath || '').replaceAll('"', '&quot;') + '" readonly /></div>' +
            '<div class="row"><button id="edReplaceBtn" type="button">Заменить файл</button></div>' +
            '<div class="row"><label><input id="edVisible" type="checkbox" ' + (s.visible === false ? '' : 'checked') + ' /> Показывать</label></div>'
        }
        srcEditor.classList.add('on')
        bindEditorLiveInputs()
        const replaceBtn = document.getElementById('edReplaceBtn')
        if (replaceBtn) {
          replaceBtn.addEventListener('click', () => {
            replacingSourceId = s.id
            replaceMediaInput.click()
          })
        }
      }

      function applyEditorChangesLive() {
        const s = sources.find((x) => x.id === editingId)
        if (!s) return
        const byId = (id) => document.getElementById(id)
        const name = byId('edName')
        if (name) s.name = name.value || s.name
        const vis = byId('edVisible')
        if (vis) s.visible = !!vis.checked
        if (s.type === 'text') {
          const t = s.text || {}
          const text = byId('edText')
          if (text) t.content = text.value || ''
          t.font = STANDARD_TEXT_FONT
          t.fontFilePath = null
          const size = byId('edSize')
          if (size) t.size = Number(size.value || 42)
          const color = byId('edColor')
          if (color) t.color = color.value || '#ffffff'
          const sc = byId('edStrokeColor')
          if (sc) t.strokeColor = sc.value || '#000000'
          const ss = byId('edStrokeSize')
          if (ss) t.strokeSize = Number(ss.value || 2)
          t.visible = s.visible !== false
          s.text = t
        }
        renderAll()
      }

      function bindEditorLiveInputs() {
        const inputs = editorBody.querySelectorAll('input, textarea, select')
        for (const el of inputs) {
          el.addEventListener('input', applyEditorChangesLive)
          el.addEventListener('change', applyEditorChangesLive)
        }
      }

      addTextBtn.addEventListener('click', () => {
        const s = {
          id: mkId('text'),
          type: 'text',
          name: 'Текст',
          locked: false,
          visible: true,
          z: 30,
          x: 40,
          y: 40,
          w: 320,
          h: 80,
          text: {
            content: 'Новый текст',
            font: STANDARD_TEXT_FONT,
            fontFilePath: null,
            size: 36,
            color: '#ffffff',
            strokeColor: '#000000',
            strokeSize: 2,
            visible: true
          }
        }
        sources.push(s)
        selectedId = s.id
        renderAll()
      })

      addMediaBtn.addEventListener('click', () => addMediaInput.click())
      function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result || ''))
          r.onerror = () => reject(r.error || new Error('read failed'))
          r.readAsDataURL(file)
        })
      }
      addMediaInput.addEventListener('change', async () => {
        const f = addMediaInput.files && addMediaInput.files[0]
        if (!f) return
        let srcUrl = ''
        const nativePath = f && typeof f === 'object' && 'path' in f ? String(f.path || '').trim() : ''
        if (nativePath) {
          srcUrl = nativePath
        } else {
          try {
            srcUrl = await readFileAsDataUrl(f)
          } catch {
            window.alert('Не удалось прочитать файл. Попробуй выбрать его снова.')
            return
          }
        }
        const isGif = /\\.gif$/i.test(f.name)
        const s = {
          id: mkId(isGif ? 'gif' : 'img'),
          type: isGif ? 'gif' : 'image',
          name: f.name,
          locked: false,
          visible: true,
          z: 25,
          x: 20,
          y: 20,
          w: 280,
          h: 280,
          src: srcUrl,
          filePath: nativePath || null
        }
        sources.push(s)
        selectedId = s.id
        renderAll()
        addMediaInput.value = ''
      })

      removeSourceBtn.addEventListener('click', () => {
        const idx = sources.findIndex((s) => s.id === selectedId)
        if (idx < 0) return
        if (sources[idx].locked) return
        sources.splice(idx, 1)
        selectedId = sources[0]?.id || null
        renderAll()
      })

      replaceMediaInput.addEventListener('change', async () => {
        const id = replacingSourceId
        replacingSourceId = null
        const s = sources.find((x) => x.id === id)
        const f = replaceMediaInput.files && replaceMediaInput.files[0]
        replaceMediaInput.value = ''
        if (!s || !f) return
        const nativePath = f && typeof f === 'object' && 'path' in f ? String(f.path || '').trim() : ''
        let srcUrl = ''
        if (nativePath) {
          srcUrl = nativePath
        } else {
          try {
            srcUrl = await readFileAsDataUrl(f)
          } catch {
            window.alert('Не удалось прочитать файл. Попробуй выбрать его снова.')
            return
          }
        }
        s.src = srcUrl
        s.filePath = nativePath || null
        s.name = f.name || s.name
        if (/\.gif$/i.test(f.name)) s.type = 'gif'
        else if (s.type !== 'text' && s.type !== 'video' && s.type !== 'overlay') s.type = 'image'
        if (editingId === s.id) openEditorForSource(s.id)
        renderAll()
      })

      editorCloseBtn.addEventListener('click', () => srcEditor.classList.remove('on'))
      ;(() => {
        let draggingEditor = false
        let startX = 0
        let startY = 0
        let originLeft = 0
        let originTop = 0
        editorTitle.addEventListener('pointerdown', (e) => {
          draggingEditor = true
          startX = e.clientX
          startY = e.clientY
          const r = editorCard.getBoundingClientRect()
          originLeft = r.left
          originTop = r.top
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          e.preventDefault()
        })
        const onMove = (e) => {
          if (!draggingEditor) return
          const nx = originLeft + (e.clientX - startX)
          const ny = originTop + (e.clientY - startY)
          editorCard.style.left = Math.max(0, nx) + 'px'
          editorCard.style.top = Math.max(0, ny) + 'px'
        }
        const onUp = () => {
          draggingEditor = false
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
      })()

      function setPendingPayload(raw) {
        try {
          window.__previewPendingPayload = String(raw || '')
        } catch {
          // ignore
        }
      }

      saveLayoutBtn.addEventListener('click', () => {
        const payload = JSON.stringify(serializeLayout())
        setPendingPayload(payload)
        window.location.href = 'preview-save://save'
      })
      function setRenderButtonState(state, text) {
        renderMinuteBtn.disabled = state === 'running'
        renderMinuteBtn.textContent = text || 'Сделать рендер 1 минуты стрима'
      }
      window.__previewRenderSet = setRenderButtonState
      renderMinuteBtn.addEventListener('click', () => {
        setRenderButtonState('running', 'Рендерим 1 минуту... 0%')
        const payload = JSON.stringify(serializeLayout())
        setPendingPayload(payload)
        window.location.href = 'preview-render://run'
      })

      previewScale.addEventListener('input', applyPreviewScale)
      async function loadSystemFonts() {
        try {
          const current = new Set(systemFonts)
          if (window.queryLocalFonts) {
            const fonts = await window.queryLocalFonts()
            const names = fonts.map((f) => f.family).filter(Boolean)
            for (const n of names) current.add(n)
          }
          systemFonts = [...current]
        } catch {
          // fallback
        }
      }

      function hardResetDefaultSources() {
        sources.length = 0
        sources.push({
          id: 'video-root',
          type: 'video',
          name: 'Видео',
          locked: true,
          visible: true,
          z: 10,
          x: 0,
          y: 0,
          w: 360,
          h: 640,
          src: ${JSON.stringify(videoUrl)}
        })
        if (${overlayUrl ? 'true' : 'false'}) {
          sources.push({
            id: 'overlay-root',
            type: 'overlay',
            name: 'Оверлей',
            locked: true,
            visible: true,
            z: 20,
            x: 12,
            y: 12,
            w: 336,
            h: 616,
            src: ${JSON.stringify(overlayUrl)}
          })
        }
        sources.push({
          id: mkId('text'),
          type: 'text',
          name: 'Текст',
          locked: false,
          visible: true,
          z: 30,
          x: 40,
          y: 40,
          w: 320,
          h: 80,
          text: {
            content: 'Текст поверх стрима',
            font: 'Arial',
            fontFilePath: null,
            size: 42,
            color: '#ffffff',
            strokeColor: '#000000',
            strokeSize: 2,
            visible: true
          }
        })
        selectedId = sources[0]?.id || null
      }

      window.addEventListener('error', (e) => {
        console.error('preview runtime error:', e.error || e.message)
      })

      try {
        applyPreviewScale()
        initSources()
        if (sources.length < 1) hardResetDefaultSources()
        renderAll()
      } catch (e) {
        console.error('preview bootstrap failed:', e)
        hardResetDefaultSources()
        renderAll()
      }
      loadSystemFonts()
    </script>
  </body>
</html>`

  const win = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  const htmlPath = join(tmpdir(), `ytu-stream-preview-${Date.now()}.html`)
  await fsp.writeFile(htmlPath, html, 'utf8')
  const readPendingPayloadJs = `(() => {
    try {
      const v = typeof window.__previewPendingPayload === 'string' ? window.__previewPendingPayload : ''
      window.__previewPendingPayload = ''
      return v
    } catch {
      return ''
    }
  })()`
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('preview-save://')) {
      event.preventDefault()
      void (async () => {
        try {
          const u = new URL(url)
          let data = decodeURIComponent(u.searchParams.get('data') ?? '')
          if (!data) {
            const fromWindow = await win.webContents.executeJavaScript(readPendingPayloadJs, true)
            data = String(fromWindow || '')
          }
          if (data && input.onSave) input.onSave(data)
          else throw new Error('empty layout payload')
          void win.webContents.executeJavaScript(`window.alert("Сохранено для канала")`)
        } catch {
          void win.webContents.executeJavaScript(`window.alert("Не удалось сохранить пресет")`)
        }
      })()
      return
    }
    if (url.startsWith('preview-render://')) {
      event.preventDefault()
      void (async () => {
        try {
          const u = new URL(url)
          let data = decodeURIComponent(u.searchParams.get('data') ?? '')
          if (!data) {
            const fromWindow = await win.webContents.executeJavaScript(readPendingPayloadJs, true)
            data = String(fromWindow || '')
          }
          if (!data || !input.onRenderMinute) {
            void win.webContents.executeJavaScript(`window.__previewRenderSet && window.__previewRenderSet("idle", "Сделать рендер 1 минуты стрима")`)
            void win.webContents.executeJavaScript(`window.alert("Рендер недоступен")`)
            return
          }
          if (input.onSave) input.onSave(data)
          const outPath = await input.onRenderMinute(data, (p) => {
            const elapsed = Math.max(0, Math.floor(p.elapsedSec))
            const remaining = Math.max(0, Math.ceil(p.remainingSec))
            const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
            const ss = String(elapsed % 60).padStart(2, '0')
            const txt = `Рендер... ${Math.round(p.percent)}% (${mm}:${ss}, осталось ~${remaining}с)`
            void win.webContents.executeJavaScript(
              `window.__previewRenderSet && window.__previewRenderSet("running", ${JSON.stringify(txt)})`
            )
          })
          void win.webContents.executeJavaScript(`window.__previewRenderSet && window.__previewRenderSet("idle", "Сделать рендер 1 минуты стрима")`)
          void win.webContents.executeJavaScript(
            `window.alert("Рендер готов:\\n${esc(outPath)}")`
          )
        } catch (e) {
          void win.webContents.executeJavaScript(`window.__previewRenderSet && window.__previewRenderSet("idle", "Сделать рендер 1 минуты стрима")`)
          const msg = e instanceof Error ? e.message : String(e)
          void win.webContents.executeJavaScript(`window.alert("Ошибка рендера: ${esc(msg)}")`)
        }
      })()
      return
    }
  })
  await win.loadFile(htmlPath)
  // Emergency fallback: if renderer script crashes before bootstrap, recover basic sources.
  void win.webContents
    .executeJavaScript(
      `(() => {
        try {
          const list = document.getElementById('sourcesList');
          const stage = document.getElementById('stage');
          if (!list || !stage) return 'no-dom';
          if (list.children.length > 0) return 'ok';
          const mkRow = (name, lock) => {
            const row = document.createElement('div');
            row.className = 'srcRow';
            row.innerHTML = '<span class="dragHandle">☰</span><div class="srcName"></div><button class="mini visBtn" type="button">●</button><span class="chip lockChip"></span>';
            row.querySelector('.srcName').textContent = name;
            row.querySelector('.lockChip').textContent = lock ? '🔒' : '';
            return row;
          };
          list.appendChild(mkRow('Видео', true));
          ${overlayUrl ? `list.appendChild(mkRow('Оверлей', true));` : ''}
          const keep = new Set(['guideV', 'guideH']);
          for (const n of [...stage.children]) if (!keep.has(n.id)) stage.removeChild(n);
          const addImgLayer = (src, x, y, w, h, z) => {
            const d = document.createElement('div');
            d.className = 'layer';
            d.style.left = x + 'px';
            d.style.top = y + 'px';
            d.style.width = w + 'px';
            d.style.height = h + 'px';
            d.style.zIndex = String(z);
            const img = document.createElement('img');
            img.src = src;
            d.appendChild(img);
            stage.appendChild(d);
          };
          addImgLayer(${JSON.stringify(videoUrl)}, 0, 0, 360, 640, 10);
          ${overlayUrl ? `addImgLayer(${JSON.stringify(overlayUrl)}, 12, 12, 336, 616, 20);` : ''}
          return 'fallback-restored';
        } catch (e) {
          return 'fallback-error:' + (e && e.message ? e.message : String(e));
        }
      })()`,
      true
    )
    .catch(() => {})
}

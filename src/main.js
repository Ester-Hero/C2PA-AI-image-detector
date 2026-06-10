import {
  createC2pa,
  selectGenerativeInfo,
  selectGenerativeSoftwareAgents,
  selectGenerativeType,
  selectProducer,
  isHandmade,
} from 'c2pa';

// Served as static files from /public — Vite copies them as-is with correct headers
const wasmSrc = '/toolkit_bg.wasm';
const workerSrc = '/c2pa.worker.min.js';

// ─── Cross-Origin Isolation Check ────────────────────────────────────────────
// c2pa requires crossOriginIsolated (COOP + COEP headers on the page).
// Show a banner immediately if the page is not isolated.
function checkCrossOriginIsolation() {
  if (!window.crossOriginIsolated) {
    const banner = document.createElement('div');
    banner.id = 'coi-banner';
    banner.innerHTML = `
      <strong>⚠ 跨域隔离未启用</strong> — 需要以下 HTTP 响应头才能运行 C2PA：
      <code>Cross-Origin-Opener-Policy: same-origin</code>
      <code>Cross-Origin-Embedder-Policy: require-corp</code>
      <br>请在终端按 <kbd>Ctrl+C</kbd> 停止服务，再运行 <kbd>npm run dev</kbd> 重启，然后<strong>强制刷新</strong>（Ctrl+Shift+R）。
    `;
    document.body.prepend(banner);
    return false;
  }
  return true;
}

// ─── DOM References ──────────────────────────────────────────────────────────
const uploadZone    = document.getElementById('uploadZone');
const fileInput     = document.getElementById('fileInput');
const uploadSection = document.getElementById('uploadSection');
const analysisSection = document.getElementById('analysisSection');
const previewImage  = document.getElementById('previewImage');
const previewMeta   = document.getElementById('previewMeta');
const loadingState  = document.getElementById('loadingState');
const resultAI      = document.getElementById('resultAI');
const resultHuman   = document.getElementById('resultHuman');
const resultUnknown = document.getElementById('resultUnknown');
const resultRemote  = document.getElementById('resultRemote');
const resultError   = document.getElementById('resultError');
const errorMessage  = document.getElementById('errorMessage');
const aiDetail      = document.getElementById('aiDetail');
const synthidSection  = document.getElementById('synthidSection');
const synthidBadge    = document.getElementById('synthidBadge');
const synthidDesc     = document.getElementById('synthidDesc');
const manifestSection = document.getElementById('manifestSection');
const manifestDetails = document.getElementById('manifestDetails');
const manifestContent = document.getElementById('manifestContent');
const collapseBtn   = document.getElementById('collapseBtn');
const tryAgainBtn   = document.getElementById('tryAgainBtn');

// ─── C2PA Instance ───────────────────────────────────────────────────────────
let c2paInstance = null;

async function getC2pa() {
  if (!c2paInstance) {
    console.log('[C2PA] crossOriginIsolated:', window.crossOriginIsolated);
    console.log('[C2PA] Initializing — fetching WASM and worker...');
    c2paInstance = await createC2pa({ wasmSrc, workerSrc });
    console.log('[C2PA] Initialized successfully');
  }
  return c2paInstance;
}

function disposeC2pa() {
  if (c2paInstance) {
    try { c2paInstance.dispose(); } catch { /* ignore */ }
    c2paInstance = null;
    console.log('[C2PA] Instance disposed — next upload will start fresh workers');
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
// Run isolation check on load
const isIsolated = checkCrossOriginIsolation();
console.log('[C2PA] crossOriginIsolated:', window.crossOriginIsolated);

uploadZone.addEventListener('click', () => { if (isIsolated) fileInput.click(); });
uploadZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});
uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file && file.type.startsWith('image/')) handleFile(file);
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});
tryAgainBtn.addEventListener('click', resetUI);
collapseBtn.addEventListener('click', toggleManifest);

// ─── Main Flow ───────────────────────────────────────────────────────────────
async function handleFile(file) {
  showAnalysisSection();
  showPreview(file);
  showLoading();

  // c2pa may hang indefinitely when the image has a remote manifest whose
  // server is unreachable. Race against a 5-second timeout to unblock the UI.
  const READ_TIMEOUT_MS = 5000;

  // Run C2PA and SynthID checks in parallel — C2PA result shown first,
  // SynthID badge updates when its API responds.
  startSynthIDCheck(file);

  try {
    console.log('[C2PA] 开始处理文件:', file.name);
    const c2pa = await getC2pa();
    console.log('[C2PA] 开始读取 C2PA 数据...');

    const readPromise = c2pa.read(file);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('remote-manifest-timeout')), READ_TIMEOUT_MS)
    );

    const { manifestStore } = await Promise.race([readPromise, timeoutPromise]);
    console.log('[C2PA] 读取完成，manifestStore:', manifestStore);
    showResult(manifestStore);
  } catch (err) {
    console.error('[C2PA] 错误:', err);
    disposeC2pa();
    if (err.message === 'remote-manifest-timeout') {
      hideLoading();
      show(resultRemote);
    } else if (isNoManifestError(err)) {
      showResult(null);
    } else {
      showError(err);
    }
  }
}

function isNoManifestError(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('no manifest') || msg.includes('jumbf')
    || msg.includes('not found') || msg.includes('no c2pa');
}

// ─── Result Display ───────────────────────────────────────────────────────────
function showResult(manifestStore) {
  hideLoading();

  if (!manifestStore) {
    show(resultUnknown);
    return;
  }

  const { activeManifest } = manifestStore;
  if (!activeManifest) {
    show(resultUnknown);
    return;
  }

  // Use the library's official selectors
  const generativeInfo = selectGenerativeInfo(activeManifest);
  const handmade = isHandmade(manifestStore);

  if (generativeInfo && generativeInfo.length > 0) {
    renderAIResult(generativeInfo, activeManifest);
    show(resultAI);
  } else if (handmade) {
    show(resultHuman);
  } else {
    // Has C2PA but no AI info and not confirmed handmade — show as human (no AI claim)
    show(resultHuman);
  }

  renderManifest(manifestStore, activeManifest, generativeInfo);
  show(manifestSection);
}

// ─── AI Result Rendering ─────────────────────────────────────────────────────
function renderAIResult(generativeInfo, manifest) {
  const agents = selectGenerativeSoftwareAgents(generativeInfo);
  const genType = selectGenerativeType(generativeInfo);
  const producer = selectProducer(manifest);

  const typeLabels = {
    trainedAlgorithmicMedia: '训练算法媒体（AI 生成）',
    compositeWithTrainedAlgorithmicMedia: '包含 AI 生成内容的合成图',
    legacy: 'Adobe 旧版生成式 AI',
  };

  let html = `
    <div class="ai-detail-row">
      <span class="tag tag-ai">类型</span>
      <span>${escHtml(typeLabels[genType] ?? genType)}</span>
    </div>
  `;

  if (agents.length > 0) {
    html += `
      <div class="ai-detail-row">
        <span class="tag tag-confidence-high">AI 工具</span>
        <span><strong>${escHtml(agents.join(' · '))}</strong></span>
      </div>
    `;
  }

  if (producer?.name) {
    html += `
      <div class="ai-detail-row">
        <span class="tag tag-confidence-med">制作者</span>
        <span>${escHtml(producer.name)}</span>
      </div>
    `;
  }

  // Show prompt if available (legacy Adobe assertion)
  const legacyAssertion = generativeInfo.find(g => g.type === 'legacy');
  const prompt = legacyAssertion?.assertion?.data?.prompt;
  if (prompt) {
    html += `
      <div class="ai-prompt">
        <span class="prompt-label">提示词 (Prompt)</span>
        <blockquote>${escHtml(prompt)}</blockquote>
      </div>
    `;
  }

  aiDetail.innerHTML = html;
}

// ─── Manifest Rendering ───────────────────────────────────────────────────────
function renderManifest(manifestStore, manifest, generativeInfo) {
  const handmade = isHandmade(manifestStore);
  const producer = selectProducer(manifest);
  const assertions = manifest.assertions ?? [];
  const signatureInfo = manifest.signatureInfo;
  const claimGen = manifest.claimGenerator;

  let html = '';

  // Verdict summary
  const verdictText = generativeInfo?.length > 0
    ? '✦ 检测到 AI 生成声明'
    : handmade
      ? '✦ 确认为人类手工创作'
      : '✦ 含有 C2PA 凭证，未检测到 AI 生成声明';

  html += `<div class="manifest-verdict">${escHtml(verdictText)}</div>`;

  // Signature
  if (signatureInfo) {
    html += section('数字签名', `
      ${row('颁发机构', signatureInfo.issuer)}
      ${row('签名时间', signatureInfo.time
        ? new Date(signatureInfo.time).toLocaleString('zh-CN') : null)}
    `);
  }

  // Claim generator
  if (claimGen?.product) {
    html += section('C2PA 声明工具', `
      ${row('产品', claimGen.product)}
      ${row('版本', claimGen.version)}
    `);
  }

  // Producer
  if (producer) {
    html += section('制作者', `
      ${row('名称', producer.name)}
      ${row('标识符', producer.identifier)}
    `);
  }

  // AI generative details
  if (generativeInfo?.length > 0) {
    const agentRows = selectGenerativeSoftwareAgents(generativeInfo)
      .map(name => `<div class="assertion-row"><code class="assertion-label">${escHtml(name)}</code><span class="badge-ai">AI 工具</span></div>`)
      .join('');
    html += section(`AI 生成信息 (${generativeInfo.length} 条)`,
      `<div class="assertions-list">${agentRows}</div>`
    );
  }

  // All assertions
  if (assertions.length > 0) {
    const assertionRows = assertions.map(a => {
      const isAI = a.label?.includes('generative') || a.label?.includes('ai');
      const isTraining = a.label === 'c2pa.training-mining';
      return `
        <div class="assertion-row">
          <code class="assertion-label">${escHtml(a.label)}</code>
          ${isAI ? '<span class="badge-ai">AI 相关</span>' : ''}
          ${isTraining ? '<span class="badge-training">训练声明</span>' : ''}
        </div>
      `;
    }).join('');
    html += section(`所有声明 (${assertions.length} 条)`,
      `<div class="assertions-list">${assertionRows}</div>`
    );
  }

  manifestDetails.innerHTML = html || '<p class="muted">无更多凭证详情</p>';
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function section(title, content) {
  const trimmed = content?.trim();
  if (!trimmed) return '';
  return `
    <div class="manifest-block">
      <h4 class="manifest-block-title">${escHtml(title)}</h4>
      ${trimmed}
    </div>
  `;
}

function row(label, value) {
  if (value == null || value === '') return '';
  return `
    <div class="manifest-row">
      <span class="manifest-key">${escHtml(label)}</span>
      <span class="manifest-val">${escHtml(String(value))}</span>
    </div>
  `;
}

function showPreview(file) {
  const url = URL.createObjectURL(file);
  previewImage.src = url;
  previewImage.onload = () => URL.revokeObjectURL(url);
  const sizeMB = (file.size / 1024 / 1024).toFixed(2);
  previewMeta.textContent = `${file.name}  ·  ${file.type}  ·  ${sizeMB} MB`;
}

function showAnalysisSection() {
  uploadSection.classList.add('hidden');
  analysisSection.classList.remove('hidden');
}

function showLoading() {
  hideAllResults();
  loadingState.classList.remove('hidden');
}

function hideLoading() {
  loadingState.classList.add('hidden');
}

function show(el) {
  el.classList.remove('hidden');
}

function hideAllResults() {
  [resultAI, resultHuman, resultUnknown, resultRemote, resultError, manifestSection, synthidSection]
    .forEach(el => el.classList.add('hidden'));
}

// ─── SynthID ─────────────────────────────────────────────────────────────────
async function startSynthIDCheck(file) {
  show(synthidSection);
  setSynthIDBadge('loading', '检测中…', '正在向 Google SynthID 服务发送请求…');

  try {
    const base64 = await fileToBase64(file);
    const res = await fetch('/api/synthid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64 }),
    });

    const data = await res.json();

    if (!data.configured) {
      setSynthIDBadge('unconfigured', '未配置',
        '需在 Vercel 环境变量中设置 GOOGLE_CLOUD_PROJECT_ID 和 GOOGLE_SERVICE_ACCOUNT_JSON');
      return;
    }

    if (data.detected) {
      setSynthIDBadge('detected', '🤖 检测到 SynthID 水印',
        `Google DeepMind SynthID 隐形水印已确认。此图片由 Google AI 工具生成。${data.score != null ? `（置信度：${(data.score * 100).toFixed(1)}%）` : ''}`);
    } else {
      setSynthIDBadge('clear', '未检测到 SynthID 水印',
        '未发现 Google SynthID 隐形水印。此图片可能不是由 Google AI 工具生成，或水印已被移除。');
    }
  } catch (err) {
    console.warn('[SynthID]', err.message);
    setSynthIDBadge('error', '检测失败', err.message);
  }
}

function setSynthIDBadge(state, label, desc) {
  synthidBadge.className = `synthid-badge ${state}`;
  synthidBadge.textContent = label;
  synthidDesc.textContent = desc;
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showError(err) {
  hideLoading();
  errorMessage.textContent = err?.message || '读取 C2PA 数据时发生未知错误';
  show(resultError);
}

function resetUI() {
  fileInput.value = '';
  analysisSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  hideAllResults();
  hideLoading();
  manifestContent.classList.add('collapsed');
  collapseBtn.setAttribute('aria-expanded', 'false');
  collapseBtn.querySelector('svg').style.transform = '';
}

function toggleManifest() {
  const expanded = collapseBtn.getAttribute('aria-expanded') === 'true';
  collapseBtn.setAttribute('aria-expanded', String(!expanded));
  manifestContent.classList.toggle('collapsed', expanded);
  collapseBtn.querySelector('svg').style.transform = expanded ? '' : 'rotate(180deg)';
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

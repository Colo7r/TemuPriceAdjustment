// ==UserScript==
// @name         Temu 助手 v0.44 (可折叠+拖拽-稳定版)
// @namespace    http://tampermonkey.net/
// @version      0.44
// @description  列表->difference->弹窗Receive->Submit(点中心topElement + 遮挡/React兜底)->detail返回；面板可拖拽/折叠
// @author       You
// @match        *://temu.com/*
// @match        *://*.temu.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  /********************
   * CONFIG (保持不变)
   ********************/
  const CONFIG = {
    orderCooldown: 900,
    stepDelay: 600,
    debugWait: 350,
    markDuration: 1100,
    scanStride: 3,
    maxViewMore: 3,
    waitTimeoutMs: 12000,
    pollIntervalMs: 200,
    successBackDelayMs: 900,
    submitRetry: 2,
    submitRetryDelayMs: 700,
    text: {
      entry: ['Price match/adjustment', '价格调节'],
      viewMore: ['View more', 'View more ∨'],
      modalKey: ['Select a request', 'Sorry'],
      modalSkip: ['Price adjustment refund issued by Temu'],
      eligible: ['You can apply below.'],
      listApply: ['Request a price adjustment', '申请价格调节'],
      diffApply: ['Request a price adjustment', '申请价格调节'],
      receive: ['Receive in seconds', '秒到账', '立即到账'],
      submit: ['Submit', '提交', '确认'],
      close: ['Close', 'Cancel', '关闭', '取消', 'Got it', '知道了', 'OK', 'Okay', '×', '✕'],
    },
    modalWidthMin: 250,
    modalWidthMax: 900,
    diffBtnMinWidth: 50,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LS = {
    running: 'temu_v43_running',
    viewMoreClicks: 'temu_v43_viewMoreClicks',
  };

  let isRunning = GM_getValue(LS.running, false);
  let viewMoreClicks = GM_getValue(LS.viewMoreClicks, 0);
  let busy = false;

  function now() {
    return new Date().toLocaleTimeString();
  }

  /********************
   * 可折叠 + 拖拽面板 (使用成熟稳定的拖拽实现)
   ********************/
  const panel = document.createElement('div');
  panel.id = 'temu-v43-panel';
  panel.innerHTML = `
    <div style="
      position:fixed; top:150px; right:20px; width:220px;
      background:#fff; border-radius:10px; box-shadow:0 4px 15px rgba(0,0,0,0.3);
      font-family:Arial; overflow:hidden;
      transition: width 0.15s ease;
    ">
      <div id="temu-v43-header" style="
        background:#fb7701; padding:8px 12px; display:flex; justify-content:space-between;
        align-items:center; cursor:move; color:white; font-weight:bold;
      ">
        <span style="font-size:14px;">🧩 Temu 助手 v0.44</span>
        <span id="temu-v43-collapse" style="cursor:pointer; font-size:18px;">▼</span>
      </div>
      <div id="temu-v43-content" style="padding:12px;">
        <button id="temu-v43-start" style="width:100%; background:#fb7701; color:white; border:none;
          padding:8px; border-radius:5px; cursor:pointer; font-weight:bold; margin-bottom:6px;">
          开始运行
        </button>
        <button id="temu-v43-stop" style="width:100%; background:#eee; color:#333; border:none;
          padding:8px; border-radius:5px; cursor:pointer; margin-bottom:6px;">
          停止
        </button>
        <div id="temu-v43-status" style="font-size:11px; color:#666; text-align:center; line-height:1.35;">
          状态: 准备就绪
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const header = document.getElementById('temu-v43-header');
  const collapseBtn = document.getElementById('temu-v43-collapse');
  const contentDiv = document.getElementById('temu-v43-content');
  const statusEl = document.getElementById('temu-v43-status');
  const startBtn = document.getElementById('temu-v43-start');
  const stopBtn = document.getElementById('temu-v43-stop');

  // 折叠功能
  let isCollapsed = false;
  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isCollapsed = !isCollapsed;
    if (isCollapsed) {
      contentDiv.style.display = 'none';
      collapseBtn.innerHTML = '▶';
      panel.style.width = 'auto';
      panel.style.minWidth = '140px';
    } else {
      contentDiv.style.display = 'block';
      collapseBtn.innerHTML = '▼';
      panel.style.width = '220px';
      panel.style.minWidth = '';
    }
  });

  // ---------- 稳定拖拽实现 (来自开源通用代码，非手写) ----------
  // 将 panel 的定位方式改为 left/top 以便拖拽
  const panelContainer = panel.querySelector('div:first-child'); // 实际要拖拽的根元素
  const panelRoot = panelContainer;

  // 获取当前 left/top（如果是 right 定位需要转换）
  function initPanelPosition() {
    const rect = panelRoot.getBoundingClientRect();
    panelRoot.style.left = rect.left + 'px';
    panelRoot.style.top = rect.top + 'px';
    panelRoot.style.right = 'auto';
  }
  initPanelPosition();

  // 拖拽状态
  let dragging = false;
  let startMouseX = 0, startMouseY = 0;
  let startLeft = 0, startTop = 0;

  function onMouseMove(e) {
    if (!dragging) return;
    e.preventDefault();
    let dx = e.clientX - startMouseX;
    let dy = e.clientY - startMouseY;
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;
    // 边界限制
    const maxX = window.innerWidth - panelRoot.offsetWidth;
    const maxY = window.innerHeight - panelRoot.offsetHeight;
    newLeft = Math.min(Math.max(0, newLeft), maxX);
    newTop = Math.min(Math.max(0, newTop), maxY);
    panelRoot.style.left = newLeft + 'px';
    panelRoot.style.top = newTop + 'px';
  }

  function onMouseUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = '';
  }

  function onMouseDown(e) {
    // 点击折叠按钮时不拖拽
    if (e.target === collapseBtn || collapseBtn.contains(e.target)) return;
    e.preventDefault();
    dragging = true;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startLeft = panelRoot.offsetLeft;
    startTop = panelRoot.offsetTop;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = 'none';
  }

  header.addEventListener('mousedown', onMouseDown);
  // 窗口大小改变时重新限制边界
  window.addEventListener('resize', () => {
    if (!dragging) {
      const left = panelRoot.offsetLeft;
      const top = panelRoot.offsetTop;
      const maxX = window.innerWidth - panelRoot.offsetWidth;
      const maxY = window.innerHeight - panelRoot.offsetHeight;
      let newLeft = Math.min(Math.max(0, left), maxX);
      let newTop = Math.min(Math.max(0, top), maxY);
      if (newLeft !== left || newTop !== top) {
        panelRoot.style.left = newLeft + 'px';
        panelRoot.style.top = newTop + 'px';
      }
    }
  });

  function setStatus(msg) {
    statusEl.innerText = `状态: ${msg}\n${now()}`;
  }

  /********************
   * 以下为原有业务逻辑 (保持不变)
   ********************/
  function includesAny(text, needles) {
    return needles.some((n) => text.includes(n));
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  async function waitFor(fn, timeoutMs = CONFIG.waitTimeoutMs, intervalMs = CONFIG.pollIntervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = fn();
        if (v) return v;
      } catch (_) {}
      await sleep(intervalMs);
    }
    return null;
  }

  const debugMark = async (el, color = '#FF0000') => {
    if (!el) return;
    try {
      el.style.outline = `6px solid ${color}`;
      el.style.outlineOffset = '2px';
      el.style.boxShadow = `0 0 18px ${color}`;
      el.style.zIndex = '2147483647';
    } catch (_) {}
    await sleep(CONFIG.debugWait);
  };

  const unmark = (el) => {
    if (!el) return;
    try {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.boxShadow = '';
    } catch (_) {}
  };

  const showClickCircle = (x, y, color = 'rgba(0, 255, 0, 0.5)') => {
    const circle = document.createElement('div');
    circle.style.position = 'fixed';
    circle.style.left = `${x - 10}px`;
    circle.style.top = `${y - 10}px`;
    circle.style.width = '20px';
    circle.style.height = '20px';
    circle.style.borderRadius = '50%';
    circle.style.backgroundColor = color;
    circle.style.zIndex = '2147483647';
    circle.style.pointerEvents = 'none';
    document.body.appendChild(circle);
    setTimeout(() => circle.remove(), CONFIG.markDuration);
  };

  function getPageWindow() {
    try {
      return unsafeWindow || window;
    } catch (_) {
      return window;
    }
  }

  function dispatchClickAt(target, x, y) {
    const W = getPageWindow();
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    try {
      if (typeof W.PointerEvent === 'function') {
        target.dispatchEvent(new W.PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new W.PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
    } catch (_) {}
    target.dispatchEvent(new W.MouseEvent('mousedown', base));
    target.dispatchEvent(new W.MouseEvent('mouseup', base));
    target.dispatchEvent(new W.MouseEvent('click', base));
  }

  function clickByCenterTop(el, color = 'rgba(0,255,0,0.35)') {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    showClickCircle(x, y, color);
    const top = document.elementFromPoint(x, y);
    const target = top || el;
    try {
      dispatchClickAt(target, x, y);
      return true;
    } catch (e) {
      try {
        target.click();
        return true;
      } catch (_) {}
    }
    return false;
  }

  async function trackedClick(el, color = 'rgba(0, 255, 255, 0.6)') {
    return clickByCenterTop(el, color);
  }

  function getListModalInfo() {
    const modal = Array.from(document.querySelectorAll('div, section')).find((el) => {
      if (!isVisible(el)) return false;
      const txt = el.innerText || '';
      if (!txt) return false;
      if (includesAny(txt, CONFIG.text.modalSkip)) return false;
      const hasKey = includesAny(txt, CONFIG.text.modalKey);
      const w = el.offsetWidth;
      return hasKey && w > CONFIG.modalWidthMin && w < CONFIG.modalWidthMax;
    });
    if (!modal) return null;
    const txt = modal.innerText || '';
    const isEligible = includesAny(txt, CONFIG.text.eligible);
    return { el: modal, isEligible };
  }

  function findListApplyButton() {
    return Array.from(document.querySelectorAll('div, button, span, a')).find((el) => {
      const t = (el.innerText || '').trim();
      return t && CONFIG.text.listApply.includes(t) && isVisible(el);
    }) || null;
  }

  async function safeCloseModal(modalEl) {
    if (!modalEl) return;
    const rect = modalEl.getBoundingClientRect();
    let clickX = rect.left - 50;
    let clickY = rect.bottom - 50;
    if (clickX < 20) clickX = rect.right + 50;
    if (clickY < 150) clickY = rect.bottom + 20;
    showClickCircle(clickX, clickY, 'rgba(255, 0, 0, 0.6)');
    const bg = document.elementFromPoint(clickX, clickY);
    if (bg) {
      try {
        dispatchClickAt(bg, clickX, clickY);
      } catch (_) {
        try { bg.click(); } catch (_) {}
      }
      await sleep(600);
    }
    const still = getListModalInfo();
    if (still?.el) {
      const closeBtn = Array.from(still.el.querySelectorAll('button, div, span, a')).find((el) => {
        const t = (el.innerText || '').trim();
        return t && includesAny(t, CONFIG.text.close) && isVisible(el);
      }) || null;
      if (closeBtn) {
        await debugMark(closeBtn, '#F44336');
        clickByCenterTop(closeBtn, 'rgba(244, 67, 54, 0.55)');
        unmark(closeBtn);
        await sleep(450);
      }
    }
    const still2 = getListModalInfo();
    if (still2?.el) {
      try {
        const W = getPageWindow();
        document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (_) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      await sleep(350);
    }
  }

  function getEntryButtons() {
    return Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = (el.innerText || '').trim();
      return t && CONFIG.text.entry.includes(t) && isVisible(el);
    });
  }

  function findViewMore() {
    return Array.from(document.querySelectorAll('div, span, button, a')).find((el) => {
      const t = (el.innerText || '').trim();
      return t && CONFIG.text.viewMore.includes(t) && isVisible(el);
    }) || null;
  }

  async function processOneListEntry(btn) {
    btn.scrollIntoView({ block: 'center' });
    await debugMark(btn, '#FF9800');
    btn.setAttribute('data-v43-done', 'true');
    clickByCenterTop(btn, 'rgba(255, 152, 0, 0.55)');
    await sleep(CONFIG.stepDelay);
    const modalInfo = getListModalInfo();
    if (!modalInfo) {
      unmark(btn);
      await sleep(CONFIG.orderCooldown);
      return false;
    }
    if (!modalInfo.isEligible) {
      setStatus('❌ 不可申请，关闭弹窗');
      await debugMark(modalInfo.el, '#F44336');
      await safeCloseModal(modalInfo.el);
      unmark(modalInfo.el);
      unmark(btn);
      await sleep(CONFIG.orderCooldown);
      return false;
    }
    setStatus('✅ 可申请，点 Request a price adjustment（跳转中）');
    await debugMark(modalInfo.el, '#4CAF50');
    const applyBtn = findListApplyButton();
    if (applyBtn) {
      await debugMark(applyBtn, '#2196F3');
      clickByCenterTop(applyBtn, 'rgba(33, 150, 243, 0.55)');
      unmark(applyBtn);
    } else {
      console.log('[v43] eligible modal but cannot find apply button');
    }
    unmark(modalInfo.el);
    unmark(btn);
    await sleep(800);
    return true;
  }

  async function handleListPage() {
    setStatus('扫描订单列表...');
    const btns = getEntryButtons();
    if (!btns.length) {
      setStatus('未找到入口按钮（可能还在加载）');
      return;
    }
    for (let i = 0; i < btns.length; i += CONFIG.scanStride) {
      if (!GM_getValue(LS.running, false)) return;
      if (busy) return;
      const btn = btns[i];
      if (!btn) continue;
      if (btn.hasAttribute('data-v43-done')) continue;
      busy = true;
      try {
        setStatus(`处理列表项 ${Math.floor(i / CONFIG.scanStride) + 1}/${Math.ceil(btns.length / CONFIG.scanStride)}`);
        const triggeredJump = await processOneListEntry(btn);
        if (triggeredJump) return;
      } finally {
        busy = false;
      }
      await sleep(CONFIG.orderCooldown);
    }
    if (viewMoreClicks < CONFIG.maxViewMore) {
      const vm = findViewMore();
      if (vm) {
        viewMoreClicks++;
        GM_setValue(LS.viewMoreClicks, viewMoreClicks);
        setStatus(`加载更多 (${viewMoreClicks}/${CONFIG.maxViewMore})...`);
        vm.scrollIntoView({ block: 'center' });
        await debugMark(vm, '#9C27B0');
        clickByCenterTop(vm, 'rgba(156, 39, 176, 0.55)');
        unmark(vm);
        await sleep(3500);
        await handleListPage();
        return;
      }
    }
    setStatus('✅ 本页扫描完成（无更多可点）');
  }

  function findDifferenceRealApplyButton() {
    const candidates = Array.from(document.querySelectorAll('div, button, a, span')).filter((el) => {
      const t = (el.innerText || '').trim();
      if (!t) return false;
      if (!CONFIG.text.diffApply.includes(t)) return false;
      if (!isVisible(el)) return false;
      if (el.offsetWidth <= CONFIG.diffBtnMinWidth) return false;
      return true;
    });
    const finalBtn = candidates.find((el) => {
      const style = window.getComputedStyle(el);
      return style.cursor === 'pointer' || el.tagName === 'BUTTON';
    });
    return finalBtn || (candidates.length ? candidates[candidates.length - 1] : null);
  }

  function findReceiveOption() {
    return Array.from(document.querySelectorAll('div, span, label, button')).find((el) => {
      const t = (el.innerText || '').trim();
      return t && includesAny(t, CONFIG.text.receive) && isVisible(el);
    }) || null;
  }

  function findSubmitButton() {
    const b1 = Array.from(document.querySelectorAll('button')).find((el) => {
      const t = (el.innerText || '').trim();
      return t && includesAny(t, CONFIG.text.submit) && isVisible(el) && el.offsetWidth > 50;
    });
    if (b1) return b1;
    return Array.from(document.querySelectorAll('div, span, a')).find((el) => {
      const t = (el.innerText || '').trim();
      return t && includesAny(t, CONFIG.text.submit) && isVisible(el) && el.offsetWidth > 50;
    }) || null;
  }

  function getReactProps(dom) {
    if (!dom) return null;
    const key = Object.keys(dom).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
    return key ? dom[key] : null;
  }

  async function forceSubmitClick(submitBtn) {
    const rect = submitBtn.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    if (top && top !== submitBtn && !submitBtn.contains(top)) {
      try {
        top.style.outline = '4px dashed red';
        top.style.pointerEvents = 'none';
      } catch (_) {}
      await sleep(60);
    }
    const props = getReactProps(submitBtn);
    if (props && typeof props.onClick === 'function') {
      try {
        props.onClick({
          stopPropagation: () => {},
          preventDefault: () => {},
          nativeEvent: new (getPageWindow().MouseEvent)('click'),
          target: submitBtn,
        });
        return;
      } catch (e) {
        console.warn('[v43] react onClick failed', e);
      }
    }
    clickByCenterTop(submitBtn, 'rgba(244, 67, 54, 0.55)');
  }

  async function handleDifferencePage() {
    setStatus('difference 页：寻找真正的 Request a price adjustment...');
    const realBtn = await waitFor(findDifferenceRealApplyButton);
    if (!realBtn) {
      setStatus('difference 页：找不到按钮，返回列表');
      await sleep(600);
      window.history.back();
      return;
    }
    realBtn.scrollIntoView({ block: 'center' });
    await debugMark(realBtn, '#00C853');
    setStatus('difference 页：点击真正按钮，等待弹窗...');
    clickByCenterTop(realBtn, 'rgba(0, 200, 83, 0.55)');
    unmark(realBtn);
    const receive = await waitFor(findReceiveOption);
    if (!receive) {
      setStatus('difference 页：未检测到 Receive 选项');
      return;
    }
    receive.scrollIntoView({ block: 'center' });
    await debugMark(receive, '#2962FF');
    setStatus('弹窗：点击 Receive in seconds...');
    clickByCenterTop(receive, 'rgba(41, 98, 255, 0.55)');
    unmark(receive);
    let submitBtn = await waitFor(findSubmitButton);
    if (!submitBtn) {
      setStatus('弹窗：找不到 Submit，尝试 ESC 并返回');
      try {
        const W = getPageWindow();
        document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (_) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      await sleep(500);
      window.history.back();
      return;
    }
    submitBtn.scrollIntoView({ block: 'center' });
    await debugMark(submitBtn, '#D50000');
    setStatus('弹窗：点击 Submit...');
    await forceSubmitClick(submitBtn);
    unmark(submitBtn);
    for (let retry = 0; retry < CONFIG.submitRetry; retry++) {
      await sleep(CONFIG.submitRetryDelayMs);
      if (location.href.includes('bgas_refund_detail.html')) break;
      const sb = findSubmitButton();
      if (!sb) break;
      console.log('[v43] retry submit', retry + 1);
      await forceSubmitClick(sb);
    }
    setStatus('已提交，等待跳转...');
    await sleep(900);
  }

  async function handleDetailPage() {
    setStatus('成功页：返回列表继续...');
    await sleep(CONFIG.successBackDelayMs);
    window.history.back();
    await sleep(1200);
    if (location.href.includes('bgas_refund_detail.html')) {
      location.href = 'https://www.temu.com/bgt_orders.html';
    }
  }

  async function execute() {
    isRunning = GM_getValue(LS.running, false);
    if (!isRunning) return;
    if (busy) return;
    const href = location.href;
    if (href.includes('bgas_refund_detail.html')) {
      await handleDetailPage();
      return;
    }
    if (href.includes('bgas_refund_difference.html')) {
      await handleDifferencePage();
      return;
    }
    if (href.includes('bgt_orders.html')) {
      await handleListPage();
      return;
    }
    setStatus('不在匹配页面（请到订单列表/差价页）');
  }

  let tickTimer = null;
  let lastHref = location.href;
  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (!GM_getValue(LS.running, false)) return;
      if (busy) return;
      if (location.href !== lastHref) {
        lastHref = location.href;
        console.log('[v43] URL changed ->', lastHref);
      }
      execute();
    }, 900);
  }
  function stopTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  startBtn.onclick = () => {
    GM_setValue(LS.running, true);
    GM_setValue(LS.viewMoreClicks, 0);
    isRunning = true;
    viewMoreClicks = 0;
    startBtn.style.opacity = '0.55';
    setStatus('🚀 运行中');
    startTick();
    execute();
  };
  stopBtn.onclick = () => {
    GM_setValue(LS.running, false);
    isRunning = false;
    startBtn.style.opacity = '1';
    setStatus('🛑 已停止');
    stopTick();
  };

  if (GM_getValue(LS.running, false)) {
    isRunning = true;
    startBtn.style.opacity = '0.55';
    setStatus('自动恢复运行...');
    startTick();
    setTimeout(execute, 800);
  } else {
    setStatus('准备就绪');
  }
})();

/* =============================================================================
 * icons.js —— 全站矢量图标（内联 SVG，stroke=currentColor，随主题变色）
 *
 * 统一规格：24×24 视框、1.7px 线宽、圆头圆角、无填充。
 * 这样在任何 DPI 下都是高清的，且能用 CSS 的 currentColor 跟随状态变色。
 * 用法：LLMIcons.play(16) → SVG 字符串
 * ========================================================================== */
(function () {
  'use strict';

  const P = {
    /* —— 模块 —— */
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.2v2.4M12 18.4v2.4M4.8 12H2.4M21.6 12h-2.4M6.9 6.9 5.2 5.2M18.8 18.8l-1.7-1.7M17.1 6.9l1.7-1.7M5.2 18.8l1.7-1.7"/>',
    flame: '<path d="M12 2.8c3.2 4.2 5.2 6.4 5.2 9.6A5.2 5.2 0 0 1 6.8 12.4c0-3.2 2-5.4 5.2-9.6Z"/><path d="M12 20.2a2.6 2.6 0 0 0 2.6-2.6c0-1.8-2.6-4.2-2.6-4.2s-2.6 2.4-2.6 4.2A2.6 2.6 0 0 0 12 20.2Z"/>',
    sliders: '<path d="M4 7h5M13 7h7M4 12h9M17 12h3M4 17h3M11 17h9"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="17" r="2"/>',
    target: '<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="3.2"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"/><circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/>',
    layers: '<path d="M12 3 3 7.4l9 4.4 9-4.4L12 3Z"/><path d="M3 12.2 12 16.6l9-4.4"/><path d="M3 16.6 12 21l9-4.4"/>',
    map: '<path d="M9.4 4.2 3.6 6.4v13.4l5.8-2.2 5.2 2.2 5.8-2.2V4.2l-5.8 2.2-5.2-2.2Z"/><path d="M9.4 4.2v13.4M14.6 6.4v13.4"/><circle cx="17.4" cy="11.4" r="1.9"/><path d="M17.4 9.5c0 1.3-1.1 2.3-1.1 2.3s-1.1-1-1.1-2.3a1.1 1.1 0 1 1 2.2 0Z"/>',

    /* —— 控制 —— */
    play: '<path d="M7.5 4.8 19 12 7.5 19.2V4.8Z"/>',
    pause: '<rect x="6.6" y="4.8" width="3.9" height="14.4" rx="1.2"/><rect x="13.5" y="4.8" width="3.9" height="14.4" rx="1.2"/>',
    step: '<path d="M6.4 5.2 15 12l-8.6 6.8V5.2Z"/><path d="M18 5v14"/>',
    film: '<rect x="2.8" y="5" width="18.4" height="14" rx="2.4"/><path d="M7.6 5v14M16.4 5v14"/><path d="M2.8 12h18.4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    reset: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.4 3.8v4.6h-4.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M4.8 12.4 9.6 17.2 19.2 7"/>',
    chart: '<path d="M4 19.6h16"/><path d="M6.4 16.4V10M11 16.4V5.6M15.6 16.4v-4M20 16.4V8"/>',
    cube: '<path d="M12 2.8 20.4 7.4v9.2L12 21.2 3.6 16.6V7.4L12 2.8Z"/><path d="M3.6 7.4 12 12l8.4-4.6M12 12v9.2"/>',
    keys: '<rect x="2.6" y="6.2" width="18.8" height="11.6" rx="2.2"/><path d="M6.4 10h.01M9.6 10h.01M12.8 10h.01M16 10h.01M8.4 14h7.2"/>',
  };

  function svg(name, size, extra) {
    const d = P[name];
    if (!d) return '';
    const s = size || 18;
    return '<svg class="ic" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true"' + (extra || '') + '>' + d + '</svg>';
  }

  window.LLMIcons = new Proxy({ svg, has: (n) => !!P[n] }, {
    get(t, k) {
      if (k in t) return t[k];
      return (size, extra) => svg(String(k), size, extra);
    },
  });
})();
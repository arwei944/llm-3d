/* =============================================================================
 * core.js —— 场景公共层：调色板、文字精灵、几何工具、渲染器/相机/控制器
 * 两个可视化模式（推理 / 训练）共用同一套 renderer 与 camera。
 * ========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------- 调色板（浅色宣纸风）
  const PAL = {
    paper: 0xf6f3ec,
    paperHi: 0xfffdf9,
    slab: 0xf1ece0,
    ink: 0x2b2723,
    ink2: 0x6b6259,
    line: 0xd8d0c2,
    edge: 0xb6ac9b,
    jade: 0x2f7d63,
    jadeLo: 0x8ecbb4,
    teal: 0x3d8f9c,
    azure: 0x4a7fb5,
    amber: 0xc98a3c,
    rust: 0xb85c38,
    violet: 0x7a6bab,
    rose: 0xc0657f,
  };
  const FONT = '"Noto Sans SC","PingFang SC","Microsoft YaHei",-apple-system,sans-serif';

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* 文字精灵：canvas 贴图。h 为世界空间高度，setLabel 会按它重算缩放。 */
  function makeTextSprite(text, opts) {
    const o = Object.assign({ size: 64, color: '#2b2723', bg: null, pad: 18, weight: 600, h: 1.0, font: FONT }, opts || {});
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `${o.weight} ${o.size}px ${o.font}`;
    ctx.font = font;
    const w = Math.max(2, Math.ceil(ctx.measureText(text).width) + o.pad * 2);
    const h = Math.max(2, Math.ceil(o.size + o.pad * 1.4));
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (o.bg) { g.fillStyle = o.bg; roundRect(g, 0, 0, w, h, h * 0.28); g.fill(); }
    g.fillStyle = o.color;
    g.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.userData.aspect = w / h;
    sp.userData.hh = o.h;
    sp.scale.set(o.h * (w / h), o.h, 1);
    return sp;
  }

  /* 就地改写精灵文字（画布尺寸变化时必须重建 GPU 纹理） */
  function setLabel(sprite, text, color, bg) {
    if (sprite.userData.txt === text && sprite.userData.clr === color && sprite.userData.bg === bg) return;
    sprite.userData.txt = text; sprite.userData.clr = color; sprite.userData.bg = bg;
    const size = 60, pad = 18;
    const font = `600 ${size}px ${FONT}`;
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const w = Math.max(2, Math.ceil(meas.measureText(text).width) + pad * 2);
    const h = Math.max(2, Math.ceil(size + pad * 1.4));
    const c = sprite.material.map.image;
    c.width = w; c.height = h;
    sprite.material.map.dispose();
    sprite.material.map = new THREE.CanvasTexture(c);
    sprite.material.map.colorSpace = THREE.SRGBColorSpace;
    sprite.material.map.minFilter = THREE.LinearFilter;
    sprite.material.map.generateMipmaps = false;
    const g = sprite.material.map.image.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (bg) { g.fillStyle = bg; roundRect(g, 0, 0, w, h, h * 0.28); g.fill(); }
    g.fillStyle = color;
    g.fillText(text, w / 2, h / 2);
    sprite.material.map.needsUpdate = true;
    const hh = sprite.userData.hh || 0.95;
    sprite.userData.aspect = w / h;
    sprite.scale.set(hh * sprite.userData.aspect, hh, 1);
  }

  // 圆角平板（token 芯片 / 面板）
  function roundedBoxGeo(w, h, d, r) {
    const shape = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2, curveSegments: 6 });
    geo.translate(0, 0, -d / 2);
    return geo;
  }

  // ---------------------------------------------------------- 场景工厂
  function createScene(container) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(PAL.paper, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PAL.paper);
    scene.fog = new THREE.Fog(PAL.paper, 80, 260);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance = 2;
    controls.maxDistance = 160;

    scene.add(new THREE.HemisphereLight(0xfffcf4, 0xd9d2c4, 0.95));
    const key = new THREE.DirectionalLight(0xfff6e8, 0.85); key.position.set(14, 26, 16); scene.add(key);
    const fill = new THREE.DirectionalLight(0xe8f0f5, 0.32); fill.position.set(-16, 10, -12); scene.add(fill);

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    resize();

    return { renderer, scene, camera, controls, resize, container };
  }

  window.LLMCore = {
    PAL, FONT, roundRect, makeTextSprite, setLabel, roundedBoxGeo, createScene,
  };
})();
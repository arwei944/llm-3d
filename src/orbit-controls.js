/* 轻量轨道控制器：拖拽旋转 / 滚轮缩放 / 右键平移
 * 自实现，避免依赖 three 的 examples 插件（UMD 包不含OrbitControls）。 */
(function () {
  'use strict';
  window.OrbitControls = function (camera, dom) {
    const c = {
      target: { x: 0, y: 0, z: 0 },
      minDistance: 0.1, maxDistance: 1000,
      minPolarAngle: 0, maxPolarAngle: Math.PI,
      enableDamping: true, dampingFactor: 0.1,
      enabled: true,
      update: function () { return true; },
    };

    // 用 THREE 的 Vector3 做运算（若不可用则退化为普通对象数学）
    const V = window.THREE && window.THREE.Vector3 ? window.THREE.Vector3 : null;
    const sph = { r: 10, theta: 0.6, phi: 1.0 };
    let drag = null;

    function currentDist() {
      if (V) return camera.position.distanceTo(new V(c.target.x, c.target.y, c.target.z));
      const dx = camera.position.x - c.target.x, dy = camera.position.y - c.target.y, dz = camera.position.z - c.target.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function syncFromCamera() {
      const dx = camera.position.x - c.target.x;
      const dy = camera.position.y - c.target.y;
      const dz = camera.position.z - c.target.z;
      sph.r = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      sph.theta = Math.atan2(dx, dz);
      sph.phi = Math.acos(Math.max(-1, Math.min(1, dy / sph.r)));
    }

    function apply() {
      const sp = Math.sin(sph.phi), cp = Math.cos(sph.phi);
      camera.position.set(
        c.target.x + sph.r * sp * Math.sin(sph.theta),
        c.target.y + sph.r * cp,
        c.target.z + sph.r * sp * Math.cos(sph.theta)
      );
      camera.lookAt(c.target.x, c.target.y, c.target.z);
    }

    // 目标值（用于阻尼插值）
    let tTheta = null, tPhi = null, tR = null;
    let tTarget = { x: 0, y: 0, z: 0 };
    let initialized = false;

    function markDirty() {
      if (!initialized) {
        syncFromCamera();
        tTheta = sph.theta; tPhi = sph.phi; tR = sph.r;
        tTarget = { x: c.target.x, y: c.target.y, z: c.target.z };
        initialized = true;
      }
    }

    dom.addEventListener('pointerdown', (e) => {
      if (!c.enabled) return;
      markDirty();
      drag = { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey };
      dom.setPointerCapture && dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.btn === 2 || drag.shift) {
        // 平移（沿相机右向量与上向量）
        const scale = tR * 0.0016;
        const right = { x: Math.cos(tTheta), y: 0, z: -Math.sin(tTheta) };
        const upx = -Math.sin(tPhi) * Math.sin(tTheta), upy = Math.cos(tPhi), upz = -Math.sin(tPhi) * Math.cos(tTheta);
        tTarget.x -= (right.x * dx - upx * dy) * scale;
        tTarget.y -= (0 * dx - upy * dy) * scale;
        tTarget.z -= (right.z * dx - upz * dy) * scale;
      } else {
        tTheta -= dx * 0.005;
        tPhi = Math.max(c.minPolarAngle, Math.min(c.maxPolarAngle, tPhi - dy * 0.005));
      }
    });
    const end = (e) => {
      if (drag) { try { dom.releasePointerCapture && dom.releasePointerCapture(e.pointerId); } catch (_) { } }
      drag = null;
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('wheel', (e) => {
      if (!c.enabled) return;
      e.preventDefault();
      markDirty();
      const k = Math.exp(e.deltaY * 0.0012);
      tR = Math.max(c.minDistance, Math.min(c.maxDistance, tR * k));
    }, { passive: false });

    c.update = function () {
      if (!initialized) return false;
      const k = c.enableDamping ? c.dampingFactor : 1;
      sph.theta += (tTheta - sph.theta) * k;
      sph.phi += (tPhi - sph.phi) * k;
      sph.r += (tR - sph.r) * k;
      c.target.x += (tTarget.x - c.target.x) * k;
      c.target.y += (tTarget.y - c.target.y) * k;
      c.target.z += (tTarget.z - c.target.z) * k;
      apply();
      return true;
    };

    // 供外部直接设置（相机预设用）
    c.setSpherical = function (theta, phi, r, tgt) {
      if (tgt) { tTarget = { x: tgt.x, y: tgt.y, z: tgt.z }; }
      tTheta = theta; tPhi = phi; tR = r;
      sph.theta = theta; sph.phi = phi; sph.r = r;
      c.target.x = tTarget.x; c.target.y = tTarget.y; c.target.z = tTarget.z;
      initialized = true;
      apply();
    };
    c.currentDistance = currentDist;

    // 初始化：先同步一次
    syncFromCamera();
    tTheta = sph.theta; tPhi = sph.phi; tR = sph.r;
    tTarget = { x: c.target.x, y: c.target.y, z: c.target.z };
    initialized = true;

    return c;
  };
})();
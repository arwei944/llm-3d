
  (function () {
    var dot = document.getElementById('statusDot'), txt = document.getElementById('statusTxt');
    setInterval(function () {
      var A = window.__app;
      if (!A) return;
      if (!A.bootDone) { txt.textContent = '训练中…'; return; }
      dot.classList.remove('busy');
      if (A.mode === 'train' && A.trainModel && A.trainModel._adam) txt.textContent = '训练中 · 迭代 ' + A.trainModel._adam.t;
      else txt.textContent = '推理中';
    }, 300);
  })();

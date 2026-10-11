/* Web Worker：在后台线程真实训练微型 Transformer，不阻塞 3D 渲染。
 * 训练完成后把权重 transferable 给主线程。 */
importScripts('./model.js');

self.onmessage = function (e) {
  const { steps = 1200, batch = 6, lr = 3e-3, seed = 7, clip = 0.5 } = e.data || {};
  const CFG = self.TinyLM.CFG;
  CFG.NL = 2;
  const model = self.TinyLM.initModel(seed);

  const post = (type, payload) => self.postMessage(Object.assign({ type }, payload));

  let last = 0;
  const hist = self.TinyLM.train(model, {
    steps, batch, lr, seed, clip,
    log: (loss, step) => {
      // 每 40 步汇报一次进度
      if (step - last >= 40 || step === 0) {
        last = step;
        post('progress', { step, steps, loss });
      }
    },
  });

  // 打包权重为可转移的 ArrayBuffer 列表
  const bufs = [];
  const meta = [];
  const pack = (arr) => { const b = arr.buffer.slice(0); bufs.push(b); meta.push(b.byteLength); return meta.length - 1; };

  const W = {
    Wte: pack(model.Wte),
    gF: pack(model.gF),
    Wlm: pack(model.Wlm),
    blm: pack(model.blm),
    blocks: model.blocks.map(b => ({
      g1: pack(b.g1), Wq: pack(b.Wq), bq: pack(b.bq),
      Wk: pack(b.Wk), bk: pack(b.bk), Wv: pack(b.Wv), bv: pack(b.bv),
      Wo: pack(b.Wo), bo: pack(b.bo), g2: pack(b.g2),
      W1: pack(b.W1), b1: pack(b.b1), W2: pack(b.W2), b2: pack(b.b2),
    })),
  };

  post('done', {
    weights: W,
    lossHist: hist,
    finalLoss: hist[hist.length - 1],
    dims: { V: CFG.V, D: CFG.D, NH: CFG.NH, FF: CFG.FF, NL: CFG.NL, dh: CFG.dh, CTX: CFG.CTX },
  }, bufs);
};
// Xunxi通话上行采集 Worklet（night-plan §2-T5 / design §6.2/§6.5）。
// 职责只有三件（分层纪律"身体无判断逻辑"，夜计划 §0：判断都在 call.js/主线程）：
//   ① 线性插值重采样到 16kHz（设备可能是 44.1k/48k——design §13-5 未实测项，此件兜平）；
//   ② 攒 40ms = 640 样本帧（spec §2.5 帧表：PCM16/16k/mono，1280B/帧无帧头）；
//   ③ PCM16 化 + RMS 能量（尾点判定的原料）→ postMessage 给主线程。
// 发送侧门控=纯机械丢帧：gate=true 时该帧不 postMessage（不进主线程不进 WS，
// design §6.5"Worklet 侧不把帧送进 WS"）。gate 由主线程按半双工状态推送
//（她说期间/未接通时关），麦克 track 本身全程不 stop（蓝牙 HFP 路由稳定）。
class XunxiPcm16kCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.gate = true                 // true=丢弃（未接通/她说期间）；主线程按状态帧推送
    this.ratio = sampleRate / 16000  // worklet 全局 sampleRate = 图速率
    this.prev = 0                    // 上一输入样本（跨 process 块携带，线性插值用）
    this.step = 0                    // 输出步进位置（样本间小数）
    this.buf = new Float32Array(640) // 40ms @16k
    this.len = 0
    this.port.onmessage = (e) => {
      if (e && e.data && typeof e.data.gate === 'boolean') this.gate = e.data.gate
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i]
      while (this.step <= 1) {
        this.buf[this.len++] = this.prev + (s - this.prev) * this.step
        this.step += this.ratio
        if (this.len === 640) this.flush()
      }
      this.step -= 1
      this.prev = s
    }
    return true
  }

  flush() {
    this.len = 0
    if (this.gate) return   // 发送侧门控：机械丢帧（不 postMessage——design §6.5）
    const pcm = new Int16Array(640)
    let sum = 0
    for (let j = 0; j < 640; j++) {
      const v = Math.max(-1, Math.min(1, this.buf[j]))
      pcm[j] = v < 0 ? v * 0x8000 : v * 0x7fff
      sum += v * v
    }
    const rms = Math.sqrt(sum / 640)
    this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer])
  }
}

registerProcessor('xunxi-pcm16k-capture', XunxiPcm16kCapture)

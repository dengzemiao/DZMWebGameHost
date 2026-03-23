<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";

const serverRunning = ref(false);
const onlineCount = ref(0);
const localIp = ref("--");
const port = ref(3000);
const address = ref("");
const loading = ref(false);
const errorMsg = ref("");

// 二维码
const qrCanvas = ref(null);

let pollTimer = null;
let initialLoaded = false;

async function fetchStatus() {
  try {
    const status = await invoke("get_server_status");
    serverRunning.value = status.running;
    onlineCount.value = status.online_count;
    localIp.value = status.local_ip;
    // 只在首次加载或服务运行中时同步端口，避免轮询覆盖用户正在编辑的值
    if (!initialLoaded || status.running) {
      port.value = status.port;
    }
    address.value = status.address;
    initialLoaded = true;
  } catch (e) {
    console.error("Failed to get status:", e);
  }
}

async function startServer() {
  loading.value = true;
  errorMsg.value = "";
  try {
    await invoke("set_port", { port: port.value });
    const addr = await invoke("start_server");
    address.value = addr;
    serverRunning.value = true;
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function stopServer() {
  loading.value = true;
  errorMsg.value = "";
  try {
    await invoke("stop_server");
    serverRunning.value = false;
    onlineCount.value = 0;
    address.value = "";
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function openDataDir() {
  try {
    await invoke("open_data_dir");
  } catch (e) {
    errorMsg.value = String(e);
  }
}

// 生成二维码
async function generateQR() {
  if (!address.value || !qrCanvas.value) return;
  try {
    await QRCode.toCanvas(qrCanvas.value, address.value, {
      width: 140,
      margin: 1,
      color: { dark: "#1a1a2e", light: "#ffffff" },
    });
  } catch (e) {
    console.error("QR generation failed:", e);
  }
}

// 监听地址变化，更新二维码
watch(address, () => {
  nextTick(generateQR);
});

onMounted(() => {
  fetchStatus();
  pollTimer = setInterval(fetchStatus, 2000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="app-container">
    <!-- 主面板 -->
    <div class="main-panel">
      <!-- 头部 -->
      <header class="header">
        <div class="logo">
          <div class="logo-icon">🎮</div>
          <div class="logo-text">
            <h1>DZMWebGameHost</h1>
            <p>局域网游戏主机服务</p>
          </div>
        </div>
      </header>

      <!-- 状态卡片 -->
      <div class="status-card" :class="{ running: serverRunning }">
        <div class="status-indicator">
          <div class="status-dot"></div>
          <span class="status-text">{{ serverRunning ? "服务运行中" : "服务已停止" }}</span>
        </div>
        <div class="online-stats" v-if="serverRunning">
          <span class="stats-number">{{ onlineCount }}</span>
          <span class="stats-label">在线</span>
        </div>
      </div>

      <!-- 信息区域 -->
      <div class="info-section">
        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">局域网 IP</span>
            <span class="info-value">{{ localIp }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">服务端口</span>
            <input
              v-if="!serverRunning"
              type="number"
              v-model.number="port"
              class="port-input"
              min="1024"
              max="65535"
            />
            <span v-else class="info-value">{{ port }}</span>
          </div>
        </div>

        <!-- 二维码区域 -->
        <div class="qr-section" :class="{ 'qr-placeholder': !serverRunning }">
          <div class="qr-wrapper">
            <canvas ref="qrCanvas" v-show="serverRunning && address"></canvas>
            <div v-show="!serverRunning" class="qr-empty">
              <span class="qr-empty-icon">📱</span>
              <span class="qr-empty-text">启动后显示二维码</span>
            </div>
          </div>
          <div class="qr-info">
            <p class="qr-tip">{{ serverRunning ? '扫码加入游戏' : '扫码加入游戏' }}</p>
            <p class="qr-address">{{ serverRunning ? address : 'http://...' }}</p>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="actions">
        <button
          v-if="!serverRunning"
          class="btn btn-primary"
          :disabled="loading"
          @click="startServer"
        >
          <span class="btn-icon">▶</span>
          {{ loading ? "启动中..." : "启动服务" }}
        </button>
        <button
          v-else
          class="btn btn-danger"
          :disabled="loading"
          @click="stopServer"
        >
          <span class="btn-icon">■</span>
          {{ loading ? "停止中..." : "停止服务" }}
        </button>
        <button class="btn btn-secondary" @click="openDataDir">
          <span class="btn-icon">📁</span>
          数据目录
        </button>
      </div>

      <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
    </div>
  </div>
</template>

<style scoped>
.app-container {
  min-height: 100vh;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  color: #e8e8e8;
  position: relative;
  overflow: hidden;
}

.main-panel {
  max-width: 420px;
  margin: 0 auto;
  padding: 32px 24px;
}

/* 头部 */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 28px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-icon {
  font-size: 36px;
  filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3));
}

.logo-text h1 {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
  background: linear-gradient(135deg, #fff 0%, #a8d8ea 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.logo-text p {
  font-size: 12px;
  color: #888;
  margin: 2px 0 0 0;
}

/* 状态卡片 */
.status-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  backdrop-filter: blur(10px);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #666;
  transition: all 0.3s;
}

.status-card.running .status-dot {
  background: #22c55e;
  box-shadow: 0 0 12px rgba(34, 197, 94, 0.6);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.status-text {
  font-size: 15px;
  font-weight: 500;
}

.online-stats {
  text-align: center;
}

.stats-number {
  display: block;
  font-size: 28px;
  font-weight: 700;
  color: #22c55e;
  line-height: 1;
}

.stats-label {
  font-size: 12px;
  color: #888;
}

/* 信息区域 */
.info-section {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 24px;
  backdrop-filter: blur(10px);
  min-height: 220px; /* 固定最小高度，刚好容纳二维码区域 */
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-label {
  font-size: 12px;
  color: #888;
}

.info-value {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  font-family: "SF Mono", Monaco, monospace;
}

.port-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  font-family: "SF Mono", Monaco, monospace;
  outline: none;
  transition: border-color 0.2s;
}

.port-input:focus {
  border-color: #396cd8;
}

/* 二维码区域 */
.qr-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 140px; /* 确保二维码区域高度 */
}

.qr-wrapper {
  background: #fff;
  padding: 8px;
  border-radius: 12px;
  flex-shrink: 0;
  width: 140px;
  height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.qr-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 124px;
  height: 124px;
  color: #888;
  gap: 8px;
}

.qr-empty-icon {
  font-size: 32px;
  opacity: 0.5;
}

.qr-empty-text {
  font-size: 11px;
  opacity: 0.6;
}

.qr-wrapper canvas {
  display: block;
  border-radius: 4px;
}

.qr-info {
  flex: 1;
  min-width: 0;
}

.qr-tip {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  margin: 0 0 6px 0;
}

.qr-address {
  font-size: 12px;
  color: #a8d8ea;
  font-family: "SF Mono", Monaco, monospace;
  margin: 0;
  word-break: break-all;
  user-select: all;
}

/* 操作按钮 */
.actions {
  display: flex;
  gap: 12px;
}

.btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px 16px;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-icon {
  font-size: 12px;
}

.btn-primary {
  background: linear-gradient(135deg, #396cd8 0%, #2d5bc0 100%);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(57, 108, 216, 0.4);
}

.btn-danger {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: #fff;
}

.btn-danger:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(239, 68, 68, 0.4);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #e8e8e8;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.15);
}

.error-msg {
  color: #ef4444;
  font-size: 13px;
  text-align: center;
  margin-top: 16px;
}
</style>

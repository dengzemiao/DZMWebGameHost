<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

const serverRunning = ref(false);
const onlineCount = ref(0);
const localIp = ref("--");
const port = ref(3000);
const address = ref("");
const loading = ref(false);
const errorMsg = ref("");

let pollTimer = null;

async function fetchStatus() {
  try {
    const status = await invoke("get_server_status");
    serverRunning.value = status.running;
    onlineCount.value = status.online_count;
    localIp.value = status.local_ip;
    port.value = status.port;
    address.value = status.address;
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

onMounted(() => {
  fetchStatus();
  pollTimer = setInterval(fetchStatus, 2000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="server-control">
    <h1 class="title">DZMWebGameHost</h1>
    <p class="subtitle">局域网游戏主机服务</p>

    <div class="info-card">
      <div class="info-row">
        <span class="label">局域网 IP</span>
        <span class="value">{{ localIp }}</span>
      </div>
      <div class="info-row">
        <span class="label">服务端口</span>
        <input
          v-if="!serverRunning"
          type="number"
          v-model.number="port"
          class="port-input"
          min="1024"
          max="65535"
        />
        <span v-else class="value">{{ port }}</span>
      </div>
      <div class="info-row" v-if="serverRunning && address">
        <span class="label">访问地址</span>
        <span class="value address">{{ address }}</span>
      </div>
    </div>

    <div class="status-card" :class="{ running: serverRunning }">
      <div class="status-dot"></div>
      <span class="status-text">
        {{ serverRunning ? "服务运行中" : "服务已停止" }}
      </span>
      <div class="online-count" v-if="serverRunning">
        <span class="count-number">{{ onlineCount }}</span>
        <span class="count-label">在线玩家</span>
      </div>
    </div>

    <div class="actions">
      <button
        v-if="!serverRunning"
        class="btn btn-start"
        :disabled="loading"
        @click="startServer"
      >
        {{ loading ? "启动中..." : "启动服务" }}
      </button>
      <button
        v-else
        class="btn btn-stop"
        :disabled="loading"
        @click="stopServer"
      >
        {{ loading ? "停止中..." : "停止服务" }}
      </button>

      <button class="btn btn-folder" @click="openDataDir">
        打开数据目录
      </button>
    </div>

    <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
  </div>
</template>

<style scoped>
.server-control {
  max-width: 480px;
  margin: 0 auto;
  padding: 40px 24px;
}

.title {
  font-size: 24px;
  font-weight: 700;
  text-align: center;
  margin: 0 0 4px 0;
}

.subtitle {
  text-align: center;
  color: #888;
  font-size: 14px;
  margin: 0 0 32px 0;
}

.info-card {
  background: var(--card-bg, #ffffff);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
}

.info-row + .info-row {
  border-top: 1px solid var(--border-color, #f0f0f0);
}

.label {
  font-size: 14px;
  color: #666;
}

.value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.value.address {
  color: #396cd8;
  font-family: monospace;
  font-size: 13px;
  user-select: all;
}

.port-input {
  width: 80px;
  text-align: right;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 14px;
  font-weight: 600;
  background: transparent;
  color: inherit;
  outline: none;
}

.port-input:focus {
  border-color: #396cd8;
}

.status-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--card-bg, #ffffff);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 24px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ccc;
  flex-shrink: 0;
}

.status-card.running .status-dot {
  background: #22c55e;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
}

.status-text {
  font-size: 14px;
  font-weight: 500;
  flex: 1;
}

.online-count {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.count-number {
  font-size: 24px;
  font-weight: 700;
  color: #396cd8;
  line-height: 1;
}

.count-label {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}

.actions {
  display: flex;
  gap: 12px;
}

.btn {
  flex: 1;
  padding: 12px 16px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-start {
  background: #396cd8;
  color: #fff;
}

.btn-start:hover:not(:disabled) {
  background: #2d5bc0;
}

.btn-stop {
  background: #ef4444;
  color: #fff;
}

.btn-stop:hover:not(:disabled) {
  background: #dc2626;
}

.btn-folder {
  background: var(--card-bg, #ffffff);
  color: var(--text-color, #333);
  border: 1px solid #ddd;
}

.btn-folder:hover {
  background: var(--hover-bg, #f5f5f5);
}

.error-msg {
  color: #ef4444;
  font-size: 13px;
  text-align: center;
  margin-top: 16px;
}

@media (prefers-color-scheme: dark) {
  .server-control {
    --card-bg: #1a1a1a;
    --border-color: #333;
    --text-color: #e5e5e5;
    --hover-bg: #2a2a2a;
  }

  .label {
    color: #aaa;
  }

  .port-input {
    border-color: #444;
  }

  .btn-folder {
    border-color: #444;
  }
}
</style>

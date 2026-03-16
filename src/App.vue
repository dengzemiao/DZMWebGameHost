<script setup>
import ServerControl from "./components/ServerControl.vue";
</script>

<template>
  <ServerControl />
</template>

<style>
:root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  font-weight: 400;
  color: #0f0f0f;
  background-color: #f6f6f6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

@media (prefers-color-scheme: dark) {
  :root {
    color: #f6f6f6;
    background-color: #0f0f0f;
  }
}
</style>

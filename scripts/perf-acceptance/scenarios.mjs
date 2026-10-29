// P7 #570: the real-product desktop performance acceptance contract, as data.
// Each scenario names what MUST be true before a measurement counts: hardware, accounts, permissions, duration and the
// metrics that must be recorded. Nothing here measures anything; run.mjs decides, from verifiable facts, whether a
// scenario could have been executed, and otherwise reports NOT EXECUTED with the exact missing requirements.
// Earlier synthetic React/Svelte A/B runs (#569) are explicitly not evidence for any of these.

export const METRICS = {
  cpuPerProcess: 'CPU % per Bridge process (main, renderer, GPU, utility) and total',
  gpuUtil: 'GPU utilization %',
  ram: 'working set / RSS per process',
  gameFps: 'game average FPS and 1% low FPS',
  mouthToEar: 'voice mouth-to-ear latency (ms) with a loopback or two-device method',
  audioGlitches: 'audio dropouts and glitches (count)',
  netStats: 'packet loss and jitter from WebRTC getStats',
  screenShare: 'capture, encoded, sent, received and presented FPS; dropped frames',
  inputLatency: 'input responsiveness (ms)',
  reconnect: 'reconnect time after network degradation (ms)',
  growth: 'resource growth over the run (slope of RSS and CPU)',
  scroll: 'scroll frame time p50/p95 and long tasks',
};

const REAL = { realBridge: true, realSfu: true };

export const SCENARIOS = [
  { id: 'PA01', title: 'Idle Bridge (signed in, one server)', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, account: 1 },
    metrics: ['cpuPerProcess', 'ram', 'growth'], realBridge: true, realSfu: false },
  { id: 'PA02', title: 'Voice chat with 2 participants', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 1, audioDevice: true },
    metrics: ['cpuPerProcess', 'ram', 'netStats', 'mouthToEar', 'audioGlitches'], ...REAL },
  { id: 'PA03', title: 'Voice chat with 5 participants', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 4, audioDevice: true },
    metrics: ['cpuPerProcess', 'ram', 'netStats', 'mouthToEar', 'audioGlitches'], ...REAL },
  { id: 'PA04', title: 'Voice chat with 10 participants', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 9, audioDevice: true },
    metrics: ['cpuPerProcess', 'ram', 'netStats', 'mouthToEar', 'audioGlitches'], ...REAL },
  { id: 'PA05', title: 'Voice chat while gaming', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 1, audioDevice: true, gameCommand: true, gpuCounters: true },
    metrics: ['cpuPerProcess', 'gpuUtil', 'ram', 'gameFps', 'mouthToEar', 'audioGlitches', 'netStats'], ...REAL },
  { id: 'PA06', title: 'Voice chat + 1080p60 screen share while gaming', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 1, audioDevice: true, gameCommand: true, gpuCounters: true, screenCapturePermission: true },
    metrics: ['cpuPerProcess', 'gpuUtil', 'ram', 'gameFps', 'screenShare', 'mouthToEar', 'audioGlitches', 'netStats'], ...REAL },
  { id: 'PA07', title: 'Voice chat + screen share + active messaging while gaming', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 2, audioDevice: true, gameCommand: true, gpuCounters: true, screenCapturePermission: true },
    metrics: ['cpuPerProcess', 'gpuUtil', 'ram', 'gameFps', 'screenShare', 'inputLatency', 'netStats'], ...REAL },
  { id: 'PA08', title: '10,000-message history load and scrolling', durationSec: 120,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, account: 1, seededMessages: 10000 },
    metrics: ['cpuPerProcess', 'ram', 'scroll', 'growth'], realBridge: true, realSfu: false },
  { id: 'PA09', title: '1440p and 4K screen capture (where the display supports them)', durationSec: 300,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 1, screenCapturePermission: true, display: ['1440p', '4k'], gpuCounters: true },
    metrics: ['cpuPerProcess', 'gpuUtil', 'screenShare'], ...REAL },
  { id: 'PA10', title: 'Network degradation and recovery during voice + screen share', durationSec: 600,
    needs: { os: ['windows', 'macos', 'linux'], packagedApp: true, remoteClients: 1, audioDevice: true, screenCapturePermission: true, networkShaper: true },
    metrics: ['netStats', 'reconnect', 'screenShare', 'mouthToEar'], ...REAL },
];

export const REQUIREMENT_TEXT = {
  packagedApp: 'the packaged Bridge desktop app for this OS (not the synthetic benchmark window)',
  account: 'a signed-in test account on a real Bridge server',
  remoteClients: 'independent remote clients on separate machines or networks, joined through the real SFU',
  audioDevice: 'a real audio input and output route (or a documented loopback cable/device)',
  gameCommand: 'a demanding game launched by BRIDGE_PERF_GAME_CMD whose FPS can be captured (for example PresentMon or MangoHud)',
  gpuCounters: 'GPU utilization counters (nvidia-smi, Windows performance counters, or a macOS power/GPU probe)',
  screenCapturePermission: 'OS screen-recording permission granted to the packaged app and an operator-confirmed picker choice',
  seededMessages: 'a channel seeded with the required number of messages',
  display: 'a physical display that supports the requested capture resolution',
  networkShaper: 'a network shaper between the client and the SFU (tc/netem, Network Link Conditioner or clumsy)',
  os: 'one of the supported operating systems',
};

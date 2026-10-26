// Shared bounded projection of the existing kernel PSI/fallback probes.
// No process identifiers, arbitrary shell text or filenames leave this module.
export async function collectKernelPressure(shell) {
  const outputs = {};
  for (const [key, command] of Object.entries({
    cpu: 'cat /proc/pressure/cpu', memory: 'cat /proc/pressure/memory', io: 'cat /proc/pressure/io',
    loadavg: 'cat /proc/loadavg', meminfo: 'cat /proc/meminfo',
  })) {
    let value = '';
    try { value = String(await shell(command)).slice(0, 32_768); } catch { /* unknown */ }
    if (key === 'loadavg') {
      const m = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) \d+\/\d+ \d+$/.exec(value.trim());
      outputs.kernelLoadavg = m && m.slice(1, 4).every(n => Number.isFinite(Number(n)))
        ? m.slice(1, 4).map(Number) : 'unavailable';
    } else if (key === 'meminfo') {
      for (const [field, name] of [['kernelMemTotalKb', 'MemTotal'], ['kernelMemAvailableKb', 'MemAvailable']]) {
        const m = new RegExp('^' + name + ':\\s+(\\d+) kB$', 'm').exec(value);
        outputs[field] = m && Number.isSafeInteger(Number(m[1])) ? Number(m[1]) : 'unavailable';
      }
    } else {
      const lines = value.split('\n').filter(line =>
        /^(?:some|full) avg10=[0-9.]+ avg60=[0-9.]+ avg300=[0-9.]+ total=[0-9]+$/.test(line));
      outputs[key] = lines.length ? lines.slice(0, 2).join(' | ').slice(0, 280) : 'unavailable';
    }
  }
  return outputs;
}

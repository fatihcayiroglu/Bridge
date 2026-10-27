// Summarize private Appium logs without retaining command bodies, device IDs,
// URLs, errors or native UI source. This is diagnostic evidence, never PASS.
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function summarizeAppiumStartup(lines) {
  const facts = {
    sessionRequests: 0, sessionResponses: 0, xcodeLines: 0,
    xcodeBuildFailed: false, xcodeTestFailed: false, wdaRunnerStarted: false,
    wdaServerMarker: false, wdaInitializationStarted: false,
    wdaInitializationFailed: false, proxyRequests: 0, proxyResponses: 0,
    inspectorConnected: false, oversizedLines: 0, truncated: false,
  };
  let scanned = 0;
  for await (const line of lines) {
    if (++scanned > 200_000) { facts.truncated = true; break; }
    if (typeof line !== 'string') continue;
    if (line.length > 16_384) { facts.oversizedLines += 1; continue; }
    const match = /^(?:\[[a-f0-9-]{8,36}\])?\[([^\]\r\n]{1,80})\]\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, tag, message] = match;
    if (tag === 'HTTP') {
      if (/^--> POST \/session(?:\s|$)/.test(message)) facts.sessionRequests += 1;
      if (/^<-- POST \/session [1-5][0-9]{2}(?:\s|$)/.test(message)) facts.sessionResponses += 1;
    } else if (tag === 'Xcode') {
      facts.xcodeLines += 1;
      if (/^\*\* BUILD FAILED \*\*/.test(message)) facts.xcodeBuildFailed = true;
      if (/^\*\* TEST FAILED \*\*/.test(message)) facts.xcodeTestFailed = true;
      if (/^Test Suite 'WebDriverAgentRunner(?:\.xctest)?' started/.test(message)) facts.wdaRunnerStarted = true;
      if (/ServerURLHere->https?:\/\/(?:127\.0\.0\.1|localhost):[0-9]+<-ServerURLHere/.test(message)) facts.wdaServerMarker = true;
    } else if (/^XCUITestDriver(?:@[a-zA-Z0-9-]+)?(?: \([^()]{1,50}\))?$/.test(tag)) {
      if (/^(?:Starting|Beginning) WebDriverAgent initialization\b/.test(message)) facts.wdaInitializationStarted = true;
      if (/^(?:Unable|Failed) to (?:launch|start) WebDriverAgent\b/.test(message)) facts.wdaInitializationFailed = true;
    } else if (tag === 'WD Proxy') {
      if (/^Proxying \[(?:GET|POST|DELETE) /.test(message)) facts.proxyRequests += 1;
      if (/^Got response with status [1-5][0-9]{2}\b/.test(message)) facts.proxyResponses += 1;
    } else if (tag === 'RemoteDebugger' && /^Connecting to remote debugger\b/.test(message)) {
      facts.inspectorConnected = true;
    }
  }
  return facts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, alive] = process.argv.slice(2);
  if (!input || !output || !['true', 'false'].includes(alive)) throw new Error('Private input, output and process-health snapshot required');
  const lines = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  fs.writeFileSync(output, JSON.stringify({ ...await summarizeAppiumStartup(lines), appiumAliveAtCleanup: alive === 'true' }, null, 2));
}

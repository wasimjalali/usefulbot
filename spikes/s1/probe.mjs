#!/usr/bin/env node
// S1 spike harness. Drives the official `opencode` CLI as a subprocess and records how the
// two OpenCode Go aliases actually behave. The CLI owns authentication; this harness never
// reads, prints or copies a credential file, and it never calls the provider directly.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR !== 24) {
  process.stderr.write(
    `S1 probe refuses to run: Node 24 is required, this interpreter is ${process.versions.node}.\n` +
    `Re-run with: PATH=/usr/local/bin:$PATH node spikes/s1/probe.mjs\n`,
  );
  process.exit(2);
}

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPIKE_DIR, '..', '..');
const FIXTURES_DIR = path.join(SPIKE_DIR, 'fixtures');
const SCRATCH_DIR = path.join(SPIKE_DIR, 'scratch');

const ALIASES = {
  workhorse: { model: 'opencode-go/glm-5.3-flash', effort: 'low' },
  reviewer: { model: 'opencode-go/glm-5.3', effort: 'high' },
};

const CASES = ['nonstream', 'stream', 'tool-roundtrip', 'fragmented-arguments', 'reasoning-replay', 'window'];

// Hard per-invocation ceilings. macOS has no `timeout` binary, so the child is killed by a
// Node timer. A killed child is UNVERIFIED, never a silent pass.
const TIMEOUTS = {
  help: 30_000,
  nonstream: 60_000,
  stream: 60_000,
  'tool-roundtrip': 90_000,
  'fragmented-arguments': 120_000,
  'reasoning-replay': 75_000,
  // The window probe sends a multi-megabyte prompt, and the largest target measured about 118
  // seconds on this machine, which sat right on the old 120 second cap and made the case flaky.
  // A timeout here is recorded as UNVERIFIED, never as a pass.
  window: 300_000,
};

const NONSTREAM_TOKEN = 'S1-NONSTREAM-OK';
const ROUNDTRIP_PLANT = 'S1-TOOL-PLANT-001';
const REPLAY_CODE = 'S1-REPLAY-CODE-001';

function log(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = { aliases: [], cases: [], out: path.join(SPIKE_DIR, 'results.json'), merge: false, finalize: null, windowTokens: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--alias') { options.aliases.push(argv[++i]); }
    else if (arg === '--case') { options.cases.push(argv[++i]); }
    else if (arg === '--out') { options.out = path.resolve(argv[++i]); }
    else if (arg === '--merge') { options.merge = true; }
    else if (arg === '--finalize') { options.finalize = argv[++i]; }
    else if (arg === '--window-tokens') { options.windowTokens = argv[++i].split(',').map((s) => Number(s.trim())); }
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else { process.stderr.write(`Unknown argument: ${arg}\n`); printUsage(); process.exit(2); }
  }
  if (options.aliases.length === 0) options.aliases = Object.keys(ALIASES);
  if (options.cases.length === 0) options.cases = [...CASES];
  for (const alias of options.aliases) {
    if (!ALIASES[alias]) { process.stderr.write(`Unknown alias: ${alias}\n`); process.exit(2); }
  }
  for (const name of options.cases) {
    if (!CASES.includes(name)) { process.stderr.write(`Unknown case: ${name}\n`); process.exit(2); }
  }
  return options;
}

function printUsage() {
  process.stdout.write(
    'Usage: PATH=/usr/local/bin:$PATH node spikes/s1/probe.mjs [--alias workhorse|reviewer] [--case <name>] [--out spikes/s1/results.json]\n' +
    `Cases: ${CASES.join(', ')}\n` +
    'Extra: --merge (carry other records forward), --finalize "<reason>" (mark missing records UNVERIFIED),\n' +
    '       --window-tokens <csv> (override window probe targets)\n',
  );
}

function runOpencode({ args, promptInput, timeoutMs, cwd = REPO_ROOT }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn('opencode', args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ spawnError: `${error && error.message}`, exitCode: null, signal: null, timedOut: false, stdout: '', stderr: '', stdinError: null, wallMs: Date.now() - startedAt });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let timedOut = false;
    let spawnError = null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => { stdinError = `${error && error.message}`; });
    child.on('error', (error) => { spawnError = `${error && error.message}`; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    if (promptInput === undefined) child.stdin.end(); else child.stdin.end(promptInput);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ spawnError, exitCode, signal, timedOut, stdout, stderr, stdinError, wallMs: Date.now() - startedAt });
    });
  });
}

function parseEvents(stdout) {
  const rawLines = stdout.split('\n').filter((line) => line.trim() !== '');
  const events = [];
  const unparsed = [];
  for (const line of rawLines) {
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      unparsed.push(line);
    }
  }
  return { events, unparsed, rawLines };
}

function textOf(events) {
  return events.filter((event) => event.type === 'text' && event.part).map((event) => event.part.text).join('');
}

function reasoningOf(events) {
  return events.filter((event) => event.type === 'reasoning' && event.part);
}

function toolCallsOf(events) {
  return events.filter((event) => event.type === 'tool_use' && event.part && event.part.type === 'tool');
}

function providerErrorOf(events) {
  const errorEvent = events.find((event) => event.type === 'error');
  if (!errorEvent) return null;
  const data = errorEvent.error && errorEvent.error.data;
  if (data && typeof data.message === 'string') return data.message;
  return JSON.stringify(errorEvent.error);
}

function sessionIdOf(events) {
  const found = events.find((event) => typeof event.sessionID === 'string');
  return found ? found.sessionID : null;
}

function lastStepTokens(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'step_finish' && event.part && event.part.tokens) return event.part.tokens;
  }
  return null;
}

function classifyFailure(result) {
  if (result.spawnError) return `spawn error: ${result.spawnError}`;
  if (result.timedOut) return `hard timeout after ${result.wallMs} ms (SIGKILL sent)`;
  return null;
}

function baseArgs(model, extra = []) {
  return ['run', '-m', model, ...extra];
}

function writeFixture(name, content) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const filePath = path.join(FIXTURES_DIR, name);
  writeFileSync(filePath, content);
  return filePath;
}

function pseudoRandomString(length) {
  let state = 0x12345678;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

const FRAGMENTED_EXPECTED = `S1-FRAG-START${pseudoRandomString(4096)}S1-FRAG-END`;

async function caseNonstream(ctx) {
  const result = await runOpencode({
    args: baseArgs(ctx.model, ['--auto']),
    promptInput: `Reply with exactly this token and nothing else: ${NONSTREAM_TOKEN}`,
    timeoutMs: TIMEOUTS.nonstream,
  });
  const failure = classifyFailure(result);
  const reply = result.stdout.trim();
  const evidence = {
    exitCode: result.exitCode,
    signal: result.signal,
    wallMs: result.wallMs,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    parsedReply: reply,
    rawStdout: result.stdout,
    rawStderr: result.stderr,
  };
  if (failure) return { status: 'UNVERIFIED', note: failure, evidence };
  const pass = result.exitCode === 0 && reply === NONSTREAM_TOKEN;
  return { status: pass ? 'PASS' : 'FAIL', evidence };
}

async function caseStream(ctx) {
  const result = await runOpencode({
    args: baseArgs(ctx.model, ['--format', 'json', '--auto']),
    promptInput: `Reply with exactly this token and nothing else: ${NONSTREAM_TOKEN}`,
    timeoutMs: TIMEOUTS.stream,
  });
  const failure = classifyFailure(result);
  const { events, unparsed, rawLines } = parseEvents(result.stdout);
  const finalText = textOf(events);
  const evidence = {
    exitCode: result.exitCode,
    signal: result.signal,
    wallMs: result.wallMs,
    stdoutBytes: Buffer.byteLength(result.stdout),
    eventCount: events.length,
    unparsedLineCount: unparsed.length,
    eventTypes: events.map((event) => event.type),
    finalText,
    firstThreeRawEvents: rawLines.slice(0, 3),
    rawStderr: result.stderr,
  };
  if (failure) return { status: 'UNVERIFIED', note: failure, evidence };
  const pass = result.exitCode === 0 && events.length > 1 && finalText === NONSTREAM_TOKEN;
  if (!pass && unparsed.length > 0) evidence.note = `${unparsed.length} stdout lines were not valid JSON`;
  return { status: pass ? 'PASS' : 'FAIL', evidence };
}

async function caseToolRoundtrip(ctx) {
  const fixturePath = writeFixture('roundtrip.txt', `planted-value: ${ROUNDTRIP_PLANT}\n`);
  const result = await runOpencode({
    args: baseArgs(ctx.model, ['--format', 'json', '--auto']),
    promptInput: `Read the file spikes/s1/fixtures/roundtrip.txt with your read tool, then reply with the planted value exactly and nothing else.`,
    timeoutMs: TIMEOUTS['tool-roundtrip'],
  });
  const failure = classifyFailure(result);
  const { events } = parseEvents(result.stdout);
  const calls = toolCallsOf(events);
  const finalText = textOf(events);
  const readCalls = calls.filter((call) => call.part.tool === 'read');
  const evidence = {
    exitCode: result.exitCode,
    signal: result.signal,
    wallMs: result.wallMs,
    fixturePath,
    fixtureBytes: Buffer.byteLength(readFileSync(fixturePath, 'utf8')),
    toolCallCount: calls.length,
    toolNames: calls.map((call) => call.part.tool),
    readCallCount: readCalls.length,
    firstReadCallRaw: readCalls.length > 0 ? JSON.stringify(readCalls[0]) : null,
    finalText,
    rawStderr: result.stderr,
  };
  if (failure) return { status: 'UNVERIFIED', note: failure, evidence };
  const pass = result.exitCode === 0 && readCalls.length > 0 && finalText.includes(ROUNDTRIP_PLANT);
  return { status: pass ? 'PASS' : 'FAIL', evidence };
}

async function caseFragmentedArguments(ctx) {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const targetPath = path.join(SCRATCH_DIR, 'fragmented-args.txt');
  if (existsSync(targetPath)) writeFileSync(targetPath, '');
  const result = await runOpencode({
    args: baseArgs(ctx.model, ['--format', 'json', '--auto']),
    promptInput:
      `Use your write tool to create the file spikes/s1/scratch/fragmented-args.txt with exactly the ` +
      `following content and nothing else. Do not add a trailing newline, do not reformat it:\n\n` +
      `${FRAGMENTED_EXPECTED}\n\nThen reply with exactly FRAG-DONE and nothing else.`,
    timeoutMs: TIMEOUTS['fragmented-arguments'],
  });
  const failure = classifyFailure(result);
  const { events } = parseEvents(result.stdout);
  const calls = toolCallsOf(events);
  const finalText = textOf(events);
  const writeCalls = calls.filter((call) => call.part.tool === 'write');
  const contentMatches = writeCalls.some((call) => call.part.state && call.part.state.input && call.part.state.input.content === FRAGMENTED_EXPECTED);
  const fileContent = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  const fileMatches = fileContent !== null && fileContent === FRAGMENTED_EXPECTED;
  const evidence = {
    exitCode: result.exitCode,
    signal: result.signal,
    expectedLength: FRAGMENTED_EXPECTED.length,
    expectedSha256Prefix: FRAGMENTED_EXPECTED.slice(0, 32),
    toolCallCount: calls.length,
    toolNames: calls.map((call) => call.part.tool),
    writeCallCount: writeCalls.length,
    writeArgumentContentMatches: contentMatches,
    writtenFile: targetPath,
    writtenFileContentMatches: fileMatches,
    writtenFileLength: fileContent === null ? null : fileContent.length,
    finalText,
    deltaObservability: 'not exposed by --format json, which emits a completed tool part; reassembly checked end to end',
    rawStderr: result.stderr,
  };
  if (failure) return { status: 'UNVERIFIED', note: failure, evidence };
  const pass = result.exitCode === 0 && writeCalls.length > 0 && contentMatches && fileMatches;
  return { status: pass ? 'PASS' : 'FAIL', evidence };
}

async function caseReasoningReplay(ctx) {
  const turnOne = await runOpencode({
    args: baseArgs(ctx.model, ['--format', 'json', '--thinking', '--variant', ctx.effort, '--auto']),
    promptInput: `Remember this code for later: ${REPLAY_CODE}. Reply with exactly OK.`,
    timeoutMs: TIMEOUTS['reasoning-replay'],
  });
  const turnOneFailure = classifyFailure(turnOne);
  const turnOneEvents = parseEvents(turnOne.stdout).events;
  const sessionId = sessionIdOf(turnOneEvents);
  const turnOneText = textOf(turnOneEvents);
  const turnOneReasoning = reasoningOf(turnOneEvents);

  let turnTwo = null;
  let turnTwoFailure = null;
  let turnTwoEvents = [];
  if (!turnOneFailure && sessionId) {
    turnTwo = await runOpencode({
      args: baseArgs(ctx.model, ['--format', 'json', '--thinking', '--variant', ctx.effort, '--auto', '--session', sessionId]),
      promptInput: 'What code did I ask you to remember? Reply with exactly the code and nothing else.',
      timeoutMs: TIMEOUTS['reasoning-replay'],
    });
    turnTwoFailure = classifyFailure(turnTwo);
    turnTwoEvents = parseEvents(turnTwo.stdout).events;
  }
  const turnTwoText = textOf(turnTwoEvents);
  const turnTwoReasoning = reasoningOf(turnTwoEvents);

  const evidence = {
    effortVariant: ctx.effort,
    sessionId,
    turnOne: {
      exitCode: turnOne.exitCode,
      finalText: turnOneText,
      reasoningEventCount: turnOneReasoning.length,
      reasoningSample: turnOneReasoning.length > 0 && turnOneReasoning[0].part ? turnOneReasoning[0].part.text : null,
      rawStderr: turnOne.stderr,
    },
    turnTwo: turnTwo === null ? null : {
      exitCode: turnTwo.exitCode,
      finalText: turnTwoText,
      reasoningEventCount: turnTwoReasoning.length,
      rawStderr: turnTwo.stderr,
    },
    reasoningReturned: turnOneReasoning.length > 0,
    reasoningReplayObservability: 'the CLI owns upstream replay; whether reasoning_content is resent cannot be observed without provider debug logs',
  };
  if (turnOneFailure) return { status: 'UNVERIFIED', note: `turn one ${turnOneFailure}`, evidence };
  if (!sessionId) return { status: 'FAIL', note: 'turn one returned no session id to continue', evidence };
  if (turnTwoFailure) return { status: 'UNVERIFIED', note: `turn two ${turnTwoFailure}`, evidence: { ...evidence, turnTwo: { exitCode: turnTwo.exitCode, signal: turnTwo.signal, rawStderr: turnTwo.stderr } } };
  const pass = turnOne.exitCode === 0 && turnOneText === 'OK' && turnTwo.exitCode === 0 && turnTwoText.includes(REPLAY_CODE);
  return { status: pass ? 'PASS' : 'FAIL', evidence };
}

const WINDOW_DEFAULT_TARGETS = [32768, 1200000];
const WINDOW_FILLER_UNIT = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ';
const WINDOW_INSTRUCTION = '\n\nIgnore the filler above. Reply with exactly WINDOW-OK and nothing else.';
const SYSTEM_TOKEN_ALLOWANCE = 12000;
const CHARS_PER_TOKEN = 3.0;

function buildWindowPrompt(inputTokens) {
  const fillerTokens = Math.max(0, inputTokens - SYSTEM_TOKEN_ALLOWANCE);
  const chars = Math.max(1, Math.round(fillerTokens * CHARS_PER_TOKEN));
  const filler = WINDOW_FILLER_UNIT.repeat(Math.ceil(chars / WINDOW_FILLER_UNIT.length)).slice(0, chars);
  return `${filler}${WINDOW_INSTRUCTION}`;
}

async function probeWindow(ctx, targetTokens, approach) {
  const attempts = [];
  let charsScale = 1;
  const maxAttempts = approach ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const target = Math.round(targetTokens * charsScale);
    const prompt = buildWindowPrompt(target);
    const result = await runOpencode({
      args: baseArgs(ctx.model, ['--format', 'json', '--auto']),
      promptInput: prompt,
      timeoutMs: TIMEOUTS.window,
    });
    const failure = classifyFailure(result);
    const { events } = parseEvents(result.stdout);
    const tokens = lastStepTokens(events);
    const providerError = providerErrorOf(events);
    const finalText = textOf(events);
    const reportedInputTokens = tokens ? tokens.input : null;
    const accepted = result.exitCode === 0 && tokens !== null;
    attempts.push({
      targetInputTokens: target,
      promptChars: prompt.length,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      accepted,
      reportedInputTokens,
      reportedTotalTokens: tokens ? tokens.total : null,
      finalText,
      providerError,
      wallMs: result.wallMs,
    });
    if (failure) break;
    if (!approach) break;
    if (reportedInputTokens !== null && reportedInputTokens >= targetTokens) break;
    if (reportedInputTokens !== null && reportedInputTokens > 0) {
      charsScale *= targetTokens / reportedInputTokens;
    } else {
      break;
    }
  }
  return attempts;
}

async function caseWindow(ctx) {
  const targets = ctx.windowTokens && ctx.windowTokens.length > 0 ? ctx.windowTokens : WINDOW_DEFAULT_TARGETS;
  const probes = [];
  targets.forEach((target, index) => probes.push({ target, approach: index === 0 }));
  const results = {};
  for (const probe of probes) {
    results[probe.target] = await probeWindow(ctx, probe.target, probe.approach);
  }
  const evidence = {
    requestedTargets: targets,
    charsPerTokenEstimate: CHARS_PER_TOKEN,
    systemTokenAllowance: SYSTEM_TOKEN_ALLOWANCE,
    probes: results,
    deltaObservability: 'token counts come from the CLI step_finish event, they are the provider reported numbers',
  };
  const anyTimeout = Object.values(results).flat().some((attempt) => attempt.timedOut || attempt.spawnError);
  if (anyTimeout) {
    const reason = Object.values(results).flat().find((attempt) => attempt.timedOut || attempt.spawnError);
    return { status: 'UNVERIFIED', note: reason.timedOut ? `hard timeout after ${reason.wallMs} ms` : `spawn error: ${reason.spawnError}`, evidence };
  }
  const allAttempts = Object.values(results).flat();
  const acceptedInputs = allAttempts.filter((attempt) => attempt.accepted && attempt.reportedInputTokens !== null).map((attempt) => attempt.reportedInputTokens);
  const highestAccepted = acceptedInputs.length > 0 ? Math.max(...acceptedInputs) : null;
  const rejected = allAttempts.find((attempt) => !attempt.accepted && attempt.providerError);
  const maxContextMatch = rejected ? rejected.providerError.match(/maximum context length is (\d+)/) : null;
  // The gate is the policy window, not sizing accuracy. This case exists to record the observed
  // boundary and prove the policy floor is served, so a probe that overshoots the target is
  // evidence for a pass. UNVERIFIED means no accepted probe reached the policy window at all.
  evidence.observed = {
    policyWindowTokens: targets[0],
    policyWindowProven: highestAccepted !== null && highestAccepted >= targets[0],
    highestAcceptedInputTokens: highestAccepted,
    firstRejectedProviderError: rejected ? rejected.providerError : null,
    providerStatedMaxContextTokens: maxContextMatch ? Number(maxContextMatch[1]) : null,
  };
  if (highestAccepted === null || highestAccepted < targets[0]) {
    return { status: 'UNVERIFIED', note: `no accepted probe reached the policy window of ${targets[0]} tokens`, evidence };
  }
  return { status: 'PASS', evidence };
}

const RUNNERS = {
  nonstream: caseNonstream,
  stream: caseStream,
  'tool-roundtrip': caseToolRoundtrip,
  'fragmented-arguments': caseFragmentedArguments,
  'reasoning-replay': caseReasoningReplay,
  window: caseWindow,
};

function loadExistingResults(outPath) {
  if (!existsSync(outPath)) return [];
  const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
  return Array.isArray(parsed.records) ? parsed.records : [];
}

function upsert(records, record) {
  const index = records.findIndex((entry) => entry.alias === record.alias && entry.case === record.case);
  if (index >= 0) records[index] = record; else records.push(record);
  return records;
}

function keyOf(record) {
  return `${record.alias}::${record.case}`;
}

function renderReport(meta, records, scope) {
  const lines = [];
  lines.push('# S1 spike report: OpenCode Go alias behaviour');
  lines.push('');
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push('');
  lines.push(`Node: ${meta.nodeVersion}. opencode: ${meta.opencodeVersion}. CLI help captured from \`opencode run --help\`.`);
  lines.push('');
  if (scope.partial) {
    lines.push(`This report is partial: scope aliases [${scope.aliases.join(', ')}], cases [${scope.cases.join(', ')}].`);
    lines.push('');
  }
  lines.push('## Results');
  lines.push('');
  lines.push('| Alias | Model | Case | Status | Wall ms | Note |');
  lines.push('|---|---|---|---|---:|---|');
  for (const record of records) {
    lines.push(`| ${record.alias} | ${record.model} | ${record.case} | ${record.status} | ${record.wallMs} | ${record.note || ''} |`);
  }
  lines.push('');
  lines.push('## What this proves');
  lines.push('');
  for (const record of records) {
    if (record.status === 'PASS') lines.push(`- ${record.alias} ${record.case}: PASS. ${summarizeEvidence(record)}`);
  }
  if (records.every((record) => record.status !== 'UNVERIFIED')) {
    lines.push('');
  }
  lines.push('');
  lines.push('## What this does not prove');
  lines.push('');
  lines.push('- The harness cannot observe token level tool argument deltas through `--format json`, which emits a completed tool part. It proves the final argument reassembled and the written file matched; it does not prove where a delta boundary fell.');
  lines.push('- The harness cannot observe whether the provider re-accepts stored reasoning content on replay. It proves the continuation turn recalled the planted value; upstream reasoning transport is only visible with provider debug logs, which were not enabled.');
  lines.push('- The window boundary is measured with generated filler text. Token counts are the provider reported `tokens.input` from the CLI, but the filler is not the production prompt and its tokenization differs.');
  lines.push('- Results reflect one macOS machine and the OpenCode Go quota state observed during the run. They do not prove sustained throughput, rate limits or availability.');
  lines.push('- Nonstream and stream replies are compared against the same chosen constant token, not against each other in a single run.');
  lines.push('');
  lines.push('## Raw CLI help (authority for flags)');
  lines.push('');
  lines.push('```');
  lines.push(meta.helpRaw.trimEnd());
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function summarizeEvidence(record) {
  const evidence = record.evidence || {};
  const parts = [];
  if (evidence.exitCode !== undefined) parts.push(`exit ${evidence.exitCode}`);
  if (evidence.eventCount !== undefined) parts.push(`${evidence.eventCount} events`);
  if (evidence.finalText !== undefined) parts.push(`final text ${JSON.stringify(String(evidence.finalText).slice(0, 80))}`);
  if (evidence.toolNames !== undefined) parts.push(`tools [${evidence.toolNames.join(', ')}]`);
  if (evidence.observed) parts.push(`highest accepted input ${evidence.observed.highestAcceptedInputTokens} tokens`);
  return parts.join(', ');
}

function markMissingUnverified(records, aliases, cases, reason) {
  for (const alias of aliases) {
    for (const name of cases) {
      const exists = records.some((record) => record.alias === alias && record.case === name);
      if (!exists) {
        records.push({ alias, model: ALIASES[alias].model, case: name, status: 'UNVERIFIED', wallMs: 0, note: reason, evidence: {} });
      }
    }
  }
  return records;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(SPIKE_DIR, { recursive: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });

  log('S1 probe: capturing authoritative CLI help and version');
  const help = await runOpencode({ args: ['run', '--help'], timeoutMs: TIMEOUTS.help });
  if (help.spawnError || help.timedOut || help.exitCode !== 0) {
    process.stderr.write(`S1 probe cannot capture opencode run --help: ${help.spawnError || (help.timedOut ? 'timeout' : `exit ${help.exitCode}`)}\n`);
    process.exit(2);
  }
  const version = await runOpencode({ args: ['--version'], timeoutMs: TIMEOUTS.help });
  const meta = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    opencodeVersion: version.stdout.trim(),
    helpRaw: help.stdout,
    aliases: ALIASES,
  };

  const records = options.merge ? loadExistingResults(options.out) : [];
  for (const alias of options.aliases) {
    for (const name of options.cases) {
      const ctx = { alias, model: ALIASES[alias].model, effort: ALIASES[alias].effort, windowTokens: options.windowTokens };
      log(`S1 probe: ${alias} / ${name} ...`);
      const outcome = await RUNNERS[name](ctx);
      const record = {
        alias,
        model: ALIASES[alias].model,
        case: name,
        status: outcome.status,
        wallMs: outcome.evidence && outcome.evidence.exitCode !== undefined && outcome.evidence.wallMs ? outcome.evidence.wallMs : (outcome.wallMs || 0),
        note: outcome.note || '',
        evidence: outcome.evidence,
      };
      upsert(records, record);
      log(`S1 probe: ${alias} / ${name} -> ${outcome.status}${outcome.note ? ` (${outcome.note})` : ''}`);
    }
  }

  if (options.finalize) {
    markMissingUnverified(records, Object.keys(ALIASES), CASES, options.finalize);
  }

  const scope = {
    aliases: options.aliases,
    cases: options.cases,
    partial: options.aliases.length !== Object.keys(ALIASES).length || options.cases.length !== CASES.length,
    finalized: options.finalize !== null,
  };
  const output = { schemaVersion: 1, meta, scope, records };
  writeFileSync(options.out, `${JSON.stringify(output, null, 2)}\n`);
  const reportPath = path.join(SPIKE_DIR, 'REPORT.md');
  writeFileSync(reportPath, renderReport(meta, records, scope));
  log(`S1 probe: wrote ${options.out}`);
  log(`S1 probe: wrote ${reportPath}`);

  const failures = records.filter((record) => record.status === 'FAIL');
  const unverified = records.filter((record) => record.status === 'UNVERIFIED');
  log(`S1 probe: ${records.length} records, ${records.length - failures.length - unverified.length} PASS, ${failures.length} FAIL, ${unverified.length} UNVERIFIED`);
  if (failures.length > 0) process.exitCode = 1;
}

main();

// Runs the speech engine (engine\engine.py: Cohere Transcribe Arabic on this PC, Google through a hidden Chrome, or a cloud
// service) and keeps it running.
// The engine reads JSON commands on stdin and writes JSON events on stdout (see engine.py).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const isWin = process.platform === 'win32';

// Where the engine's Python is. Setup puts a Python of the app's own in engine\python (nothing has to be installed on
// the PC, and the folder can be copied to another one). Installs from before that have a virtual environment in
// engine\.venv instead, which is used when the other is not there. "home" is the folder with ready.txt in it.
// (The Mac app carries its own Python in engine/python too: bin/python3, packages in lib/python3.x/site-packages.)
function enginePython(dir) {
  const home = path.join(dir, 'python');
  const own = isWin ? path.join(home, 'python.exe') : path.join(home, 'bin', 'python3');
  if (fs.existsSync(own) && fs.existsSync(path.join(home, 'ready.txt'))) return { exe: own, home, packages: sitePackages(home) };
  const venv = path.join(dir, '.venv');
  return { exe: isWin ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'), home: venv, packages: sitePackages(venv) };
}
function sitePackages(home) {
  if (isWin) return path.join(home, 'Lib', 'site-packages');
  try { const v = fs.readdirSync(path.join(home, 'lib')).find(d => /^python3\.\d+$/.test(d)); if (v) return path.join(home, 'lib', v, 'site-packages'); } catch { /* not there */ }
  return path.join(home, 'lib', 'site-packages');
}

// A venv's python.exe is a small launcher that starts the real Python as its own child, so stopping
// the engine has to stop that whole tree (or the real one keeps running, holding the graphics card).
function killTree(child) {
  if (!child) return;
  try { child.stdin.end(); } catch { /* already closed */ }
  if (isWin && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; } catch { /* fall through */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

class Speech extends EventEmitter {
  constructor(root) {
    super();
    this.dir = path.join(root, 'engine');
    this.child = null;
    this.gpuRestartAt = 0;          // when the engine last started afresh because the graphics card failed
    this.state = 'stopped';         // stopped | starting | loading | ready | listening | error | no-model | not-installed
    this.message = '';
    this.info = {};                 // device, where, gpu, model
    this.log = [];
    this.devices = { mics: [], speakers: [] };
    this.listening = false;         // what the operator wants
    this.input = { kind: 'mic', name: '' };
    this.config = { language: 'auto', pause: 0.5, maxLen: 15, sensitivity: 0.5, device: 'auto' };
    this.lastEvent = 0;
    this.restarts = [];
    this.stopping = false;
    this.inputState = null;
    this.file = null;               // the test recording that is playing
    this.hb = {};
    setInterval(() => this.watch(), 3000).unref();
  }

  get python() { return enginePython(this.dir).exe; }
  installed() { try { return fs.existsSync(this.python); } catch { return false; } }

  addLog(line) {
    line = String(line).replace(/\s+$/, '');
    if (!line || /Loading weights|it\/s\]|Redirects are currently not supported/.test(line)) return;
    this.log.push(line);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.emit('log', line);
  }

  status() {
    return Object.assign({ state: this.state, message: this.message, installed: this.installed(), listening: this.listening,
      running: !!this.child, input: this.input, inputState: this.inputState, file: this.file, backlog: this.hb.backlog || 0,
      speed: this.hb.speed, recording: !!this.hb.recording }, this.info);
  }
  setState(state, message) {
    if (state) this.state = state;
    if (message !== undefined) this.message = message;
    this.emit('status', this.status());
  }

  send(obj) {
    if (!this.child || !this.child.stdin.writable) return false;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  start() {
    if (this.child) return;
    if (this.gate) {                // the app is still looking at this PC (which speech recognition "Automatic" means)
      if (!this.gateWaiting) {
        this.gateWaiting = true;
        this.setState('starting', 'Starting the speech engine…');
        this.gate.catch(() => {}).then(() => { this.gate = null; this.gateWaiting = false; if (!this.stopping) this.start(); });
      }
      return;
    }
    if (!this.installed()) { this.setState('not-installed', 'The speech engine is not installed yet. Run Setup.bat once (it takes a few minutes).'); return; }
    this.stopping = false;
    this.setState('starting', 'Starting the speech engine…');
    let child;
    try {
      // (-s and PYTHONNOUSERSITE: only the packages Setup installed, never ones from a Python the user has of their own)
      child = spawn(this.python, ['-u', '-s', 'engine.py', '--managed', '--device', this.config.device || 'auto', '--language', this.config.language || 'auto',
        '--provider', this.config.provider || 'local'], {
        cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        // (PYTHONDONTWRITEBYTECODE on a Mac: nothing may be written inside the app; its Python files come compiled)
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1',
          VF_STT_KEY: this.cloudKey || '', VF_CHROME: this.chrome || '', VF_GPU_RESTART_AT: String(Math.round(this.gpuRestartAt / 1000)) },
          isWin ? {} : { PYTHONDONTWRITEBYTECODE: '1' }),
      });
    } catch (e) { this.setState('error', 'Could not start the speech engine: ' + e.message); return; }
    this.child = child;
    this.lastEvent = Date.now();
    child.stdin.on('error', e => this.addLog('(could not send to the speech engine: ' + e.message + ')'));
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { this.addLog(line); continue; }
        this.onEvent(ev);
      }
    });
    let ebuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => {
      ebuf += d;
      let i;
      while ((i = ebuf.search(/[\r\n]/)) >= 0) { this.addLog(ebuf.slice(0, i)); ebuf = ebuf.slice(i + 1); }
    });
    child.on('error', e => this.addLog('Could not start: ' + e.message));
    child.on('exit', code => {
      if (this.child !== child) return;
      this.child = null;
      this.addLog(`(speech engine exited, code ${code})`);
      this.hb = {};
      if (this.stopping) { this.setState('stopped', 'Stopped'); return; }
      // It stopped itself on purpose, to be started afresh: the graphics card failed (42), or the model sat on one
      // sentence for ever (43). Neither counts as a crash.
      if (code === 42 || code === 43) {
        if (code === 42) this.gpuRestartAt = Date.now();
        this.setState('error', code === 42 ? 'The graphics card had a problem. Restarting the speech engine…' : 'The speech model was stuck. Restarting the speech engine…');
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.start(), 800);
        return;
      }
      // it should never stop on its own: start it again, waiting longer if it keeps failing
      const now = Date.now();
      this.restarts = this.restarts.filter(t => now - t < 120000);
      this.restarts.push(now);
      const wait = this.restarts.length <= 2 ? 1500 : this.restarts.length <= 5 ? 8000 : 30000;
      this.setState('error', `The speech engine stopped unexpectedly. Restarting it in ${Math.round(wait / 1000)} s… (Settings → Speech engine shows the log)`);
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.start(), wait);
    });
    // tell it what we want
    this.send(Object.assign({ cmd: 'config' }, this.config));
    this.send(Object.assign({ cmd: 'input' }, this.input));
    this.send({ cmd: 'listen', on: this.listening });
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    this.send({ cmd: 'quit' });
    setTimeout(() => { if (this.child === child) killTree(child); }, 3000);
  }

  restart() {
    const child = this.child;
    this.restarts = [];
    if (!child) return this.start();
    this.stopping = true;
    child.once('exit', () => { this.stopping = false; setTimeout(() => this.start(), 300); });
    this.stop();
  }

  // a stuck engine (no word from it for a while) is restarted; while loading a model it can be quiet longer
  watch() {
    if (!this.child) return;
    const quiet = Date.now() - this.lastEvent;
    const limit = this.state === 'loading' || this.state === 'starting' ? 240000 : 20000;
    if (quiet > limit) {
      this.addLog(`(no answer from the speech engine for ${Math.round(quiet / 1000)} s: restarting it)`);
      const child = this.child;
      this.child = null;
      killTree(child);
      this.setState('error', 'The speech engine stopped answering. Restarting it…');
      setTimeout(() => this.start(), 1000);
    }
  }

  onEvent(ev) {
    this.lastEvent = Date.now();
    switch (ev.ev) {
      case 'status': {
        this.info = { device: ev.device, where: ev.where, gpu: ev.gpu, model: ev.model };
        let st = ev.state;
        if (st === 'ready' && this.listening) st = 'listening';
        this.setState(st, ev.message);
        if (st === 'ready' || st === 'listening') this.restarts = [];
        break;
      }
      // (a Mac also says loopback: false, os: 'darwin')
      case 'devices': this.devices = { mics: ev.mics || [], speakers: ev.speakers || [], loopback: ev.loopback, os: ev.os }; this.emit('devices', this.devices); break;
      case 'input':
        this.inputState = { kind: ev.kind, name: ev.name, ok: ev.ok, message: ev.message || '', silent: !!ev.silent };
        if (!ev.ok && ev.message) this.addLog('Input problem: ' + ev.message);
        this.emit('status', this.status());
        break;
      case 'level': this.emit('level', { db: ev.db, speech: ev.speech }); break;
      case 'partial': this.emit('transcript', { text: ev.text, final: false, lang: ev.lang, seg: ev.seg }); break;
      case 'final':
        // rec, at: the sound file this sentence is in and how many seconds into it (when the service is being recorded)
        this.emit('transcript', { text: ev.text, final: true, lang: ev.lang, seg: ev.seg, start: ev.start, dur: ev.dur, ms: ev.ms, late: ev.late || undefined,
          rec: ev.rec || undefined, at: ev.rec ? ev.at : undefined, score: ev.score || undefined });
        if (ev.billed) this.emit('billed', { seconds: ev.billed, provider: ev.provider });
        break;
      case 'billed': this.emit('billed', { seconds: ev.seconds, provider: ev.provider }); break;
      case 'file':
        this.file = Object.assign({}, ev);
        delete this.file.ev;
        if ((ev.state === 'ended' || ev.state === 'stopped' || ev.state === 'error') && this.input.kind === 'file' && ev.name === path.basename(this.input.path || '')) {
          this.input = this.prevInput || { kind: 'mic', name: '' };
          // a test recording: afterwards, listening is as it was before the test
          if (this.listenBeforeFile === false && this.listening) { this.listenBeforeFile = null; this.setListening(false); }
          setTimeout(() => { if (this.file && this.file.state !== 'playing' && this.file.state !== 'paused') this.file = null; this.emit('status', this.status()); }, 4000);
        }
        this.emit('file', this.file);
        break;
      case 'warn': this.addLog('!! ' + ev.message); this.emit('warn', ev.message); break;
      case 'log': this.addLog(ev.message); break;
      case 'hb': this.hb = ev; break;
      case 'recording': this.emit('recording', { file: ev.file, on: !!ev.on, began: ev.began, seconds: ev.seconds }); break;
      case 'command-text': {
        const p = this.pendingCmds && this.pendingCmds.get(ev.id);
        if (p) { this.pendingCmds.delete(ev.id); clearTimeout(p.timer); if (ev.error) p.reject(new Error(ev.error)); else p.resolve(ev.text || ''); }
        break;
      }
      case 'hello': this.addLog(`Speech engine ${ev.version} started (process ${ev.pid}).`); break;
      default: break;
    }
  }

  // ---- what the app asks for
  setListening(on) {
    this.listening = !!on;
    if (!this.child && this.listening) this.start();
    this.send({ cmd: 'listen', on: this.listening });
    if (this.state === 'ready' && on) this.setState('listening');
    else if (this.state === 'listening' && !on) this.setState('ready');
    else this.emit('status', this.status());
  }
  setConfig(c) {
    Object.assign(this.config, c);
    this.send(Object.assign({ cmd: 'config' }, this.config));
  }
  setInput(spec) {
    if (spec.kind === 'file') {
      if (this.input.kind !== 'file') { this.prevInput = this.input; this.listenBeforeFile = this.listening; }
      this.file = { state: 'starting', t: 0, dur: 0, name: path.basename(spec.path || '') };
    } else this.prevInput = null;
    this.input = spec;
    if (!this.child) this.start(); else this.send(Object.assign({ cmd: 'input' }, spec));
    this.emit('status', this.status());
  }
  fileControl(action, t) { this.send({ cmd: 'file', action, t }); }
  // a spoken command (phone remote): transcribe one short recording
  transcribeOnce(file) {
    this.pendingCmds = this.pendingCmds || new Map();
    const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    return new Promise((resolve, reject) => {
      if (!this.child || !this.send({ cmd: 'transcribe', id, path: file })) return reject(new Error('the speech engine is not running'));
      const timer = setTimeout(() => { this.pendingCmds.delete(id); reject(new Error('the speech engine took too long')); }, 25000);
      this.pendingCmds.set(id, { resolve, reject, timer });
    });
  }
  refreshDevices() { this.send({ cmd: 'devices' }); }
}

module.exports = { Speech, killTree, enginePython };
